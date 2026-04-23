import { StateGraph, interrupt, Command } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools, executeApprovedToolCall } from "./tools/adapters";
import { toolRequiresConfirmation } from "./tools/catalog";
import {
  getSessionMessages,
  addMessage,
  createToolCall,
  updateToolCallStatus,
  findExistingPendingToolCall,
} from "@agents/db";
import { getCheckpointer } from "./checkpointer";
import { GraphState } from "./state";
import { compactionNode } from "./nodes/compaction_node";

export interface AgentInput {
  message?: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  googleAccessToken?: string | null;
  resumeDecision?: "approve" | "reject";
}

export interface PendingConfirmation {
  tool_call_id: string;
  message: string;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
}

const MAX_TOOL_ITERATIONS = 6;

function buildConfirmationMessage(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "github_create_issue":
      return `Crear issue "${args.title}" en ${args.owner}/${args.repo}.`;
    case "github_create_repo": {
      const visibility = args.private ? "privado" : "público";
      return `Crear repositorio ${visibility} "${args.name}"${args.description ? `: ${args.description}` : ""}.`;
    }
    case "google_calendar_confirm_attendance":
      return `Confirmar asistencia al evento con ID: ${args.event_id}.`;
    case "bash": {
      const rawPrompt = String(args.prompt ?? "");
      const preview = rawPrompt.length > 200 ? rawPrompt.slice(0, 200) + "…" : rawPrompt;
      const terminalTag = args.terminal ? ` [terminal: ${args.terminal}]` : "";
      return `Ejecutar comando bash${terminalTag}: \`${preview}\``;
    }
    case "write_file": {
      const rawContent = String(args.content ?? "");
      const preview = rawContent.length > 120 ? rawContent.slice(0, 120) + "…" : rawContent;
      return `Crear archivo \`${args.path}\` con contenido:\n\`\`\`\n${preview}\n\`\`\``;
    }
    case "edit_file": {
      const rawOld = String(args.old_string ?? "");
      const rawNew = String(args.new_string ?? "");
      const oldPreview = rawOld.length > 80 ? rawOld.slice(0, 80) + "…" : rawOld;
      const newPreview = rawNew.length > 80 ? rawNew.slice(0, 80) + "…" : rawNew;
      return `Editar archivo \`${args.path}\`:\n- Reemplazar: \`${oldPreview}\`\n- Por: \`${newPreview}\``;
    }
    case "schedule_task": {
      const schedType = args.schedule_type === "one_time" ? "una vez" : "recurrente";
      const when = args.schedule_type === "one_time"
        ? `para: ${args.run_at}`
        : `con cron: \`${args.cron_expr}\``;
      const promptPreview = String(args.prompt ?? "").slice(0, 120);
      return `Crear tarea programada (${schedType}) ${when}:\n"${promptPreview}"`;
    }
    default:
      return `Ejecutar acción: ${toolName}.`;
  }
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const { userId, sessionId, systemPrompt, db, enabledTools, integrations, githubToken, googleAccessToken, resumeDecision } = input;
  const message = input.message;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubToken,
    googleAccessToken,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const { ToolMessage } = await import("@langchain/core/messages");

    // Inject placeholder ToolMessages for any AIMessage whose tool_calls have no responses.
    // This can happen when an interrupt() fired inside toolExecutorNode (HITL) and the
    // user sent a new message instead of approving/rejecting — the checkpointer persists
    // the AIMessage with tool_calls but without the following ToolMessages.
    const sanitized: BaseMessage[] = [];
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      sanitized.push(msg);
      if (msg instanceof AIMessage && msg.tool_calls?.length) {
        const nextMsg = state.messages[i + 1];
        if (!(nextMsg instanceof ToolMessage)) {
          for (const tc of msg.tool_calls) {
            sanitized.push(
              new ToolMessage({
                content: JSON.stringify({ status: "cancelled", message: "Acción cancelada automáticamente." }),
                tool_call_id: tc.id!,
              })
            );
          }
        }
      }
    }

    const response = await modelWithTools.invoke(sanitized);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];

    for (const tc of lastMsg.tool_calls) {
      toolCallNames.push(tc.name);
      const needsConfirm = toolRequiresConfirmation(tc.name);

      if (needsConfirm) {
        const args = tc.args as Record<string, unknown>;
        const existing = await findExistingPendingToolCall(db, sessionId, tc.name);
        const record = existing ?? await createToolCall(db, sessionId, tc.name, args, true);

        const confirmMsg = buildConfirmationMessage(tc.name, args);
        const decision = interrupt({
          tool_call_id: record.id,
          tool_name: tc.name,
          message: confirmMsg,
          args,
        }) as "approve" | "reject";

        if (decision === "reject") {
          await updateToolCallStatus(db, record.id, "rejected");
          results.push(
            new ToolMessage({
              content: JSON.stringify({ status: "rejected", message: "Acción cancelada por el usuario." }),
              tool_call_id: tc.id!,
            })
          );
        } else {
          try {
            const result = await executeApprovedToolCall(
              db,
              record.id,
              tc.name,
              args,
              githubToken,
              googleAccessToken
            );
            results.push(
              new ToolMessage({
                content: JSON.stringify(result),
                tool_call_id: tc.id!,
              })
            );
          } catch (err) {
            results.push(
              new ToolMessage({
                content: JSON.stringify({ error: String(err) }),
                tool_call_id: tc.id!,
              })
            );
          }
        }
      } else {
        const matchingTool = lcTools.find((t) => t.name === tc.name);
        if (matchingTool) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (matchingTool as any).invoke(tc.args);
          results.push(new ToolMessage({ content: String(result), tool_call_id: tc.id! }));
        }
      }
    }

    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addNode("compaction", compactionNode)
    .addEdge("__start__", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });
  const config = { configurable: { thread_id: sessionId } };

  let finalState: typeof GraphState.State & { __interrupt__?: Array<{ value: unknown }> };

  if (resumeDecision) {
    finalState = await app.invoke(new Command({ resume: resumeDecision }), config);
  } else {
    if (!message) throw new Error("message is required when resumeDecision is not set");

    const history = await getSessionMessages(db, sessionId, 30);
    await addMessage(db, sessionId, "user", message);

    // For new sessions pass the system prompt; for existing ones the checkpointer
    // already holds the full state (AIMessage with tool_calls, ToolMessages, etc.)
    // so we only append the new human message to avoid corrupting the thread.
    const initialMessages: BaseMessage[] = history.length === 0
      ? [new SystemMessage(systemPrompt), new HumanMessage(message)]
      : [new HumanMessage(message)];

    finalState = await app.invoke(
      { messages: initialMessages, sessionId, userId, systemPrompt },
      config
    );
  }

  // Graph paused at interrupt — return pendingConfirmation without saving assistant message
  if (finalState.__interrupt__?.length) {
    const interruptPayload = finalState.__interrupt__[0].value as {
      tool_call_id: string;
      message: string;
    };
    const pendingConfirmation: PendingConfirmation = {
      tool_call_id: interruptPayload.tool_call_id,
      message: interruptPayload.message,
    };

    await addMessage(db, sessionId, "assistant", interruptPayload.message, {
      structured_payload: { pending_confirmation: true, ...interruptPayload },
    });

    return { response: interruptPayload.message, toolCalls: toolCallNames, pendingConfirmation };
  }

  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  await addMessage(db, sessionId, "assistant", responseText);

  return { response: responseText, toolCalls: toolCallNames, pendingConfirmation: null };
}
