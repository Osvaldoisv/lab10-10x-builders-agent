import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { createCompactionModel } from "../model";
import type { GraphState } from "../state";

const RECENT_TOOL_KEEP = 5;
const RECENT_TAIL = 10;
const MAX_CONTEXT_CHARS = 512_000; // ~128K tokens × 4 chars/token
const COMPACTION_THRESHOLD = 0.8;
const MAX_FAILURES = 3;

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compactor. Summarize the conversation history into exactly 9 structured sections:

1. **Context & Goal**: The main objective and context
2. **Key Decisions**: Important decisions made
3. **Actions Taken**: Tools called and their outcomes
4. **Current State**: What has been accomplished so far
5. **Pending Items**: What still needs to be done
6. **User Preferences**: Any user preferences or constraints noted
7. **Important Data**: Key data points, IDs, or values referenced
8. **Errors & Issues**: Any errors or issues encountered
9. **Next Steps**: Logical next actions

Be concise but complete. Preserve all actionable information. Do not include any <analysis> tags.`;

function estimateChars(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);
}

function sanitize(text: string): string {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

function microcompact(messages: BaseMessage[]): BaseMessage[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] instanceof ToolMessage) toolIndices.push(i);
  }

  const toClean = new Set(
    toolIndices.slice(0, Math.max(0, toolIndices.length - RECENT_TOOL_KEEP))
  );

  return messages.map((msg, i) => {
    if (!toClean.has(i)) return msg;
    const tm = msg as ToolMessage;
    return new ToolMessage({
      id: tm.id,
      content: "[tool result cleared]",
      tool_call_id: tm.tool_call_id,
    });
  });
}

export async function compactionNode(
  state: typeof GraphState.State
): Promise<Partial<typeof GraphState.State>> {
  const { messages, compactionCount } = state;

  // Circuit breaker: 3 consecutive LLM compaction failures → passthrough
  if (compactionCount >= MAX_FAILURES) {
    return { compactionCount: 0 };
  }

  // Stage 1: microcompact (always, zero LLM cost)
  const afterMicro = microcompact(messages);
  const changed = afterMicro.filter((m, i) => m !== messages[i]);

  // Stage 2: check threshold for LLM compaction
  if (estimateChars(afterMicro) <= MAX_CONTEXT_CHARS * COMPACTION_THRESHOLD) {
    if (changed.length === 0) return { compactionCount: 0 };
    return { messages: changed as BaseMessage[], compactionCount: 0 };
  }

  // Stage 3: LLM compaction
  try {
    const model = createCompactionModel();

    const systemMsgs = afterMicro.filter((m) => m instanceof SystemMessage);
    const nonSystem = afterMicro.filter((m) => !(m instanceof SystemMessage));
    const toSummarize = nonSystem.slice(0, Math.max(0, nonSystem.length - RECENT_TAIL));
    const recentTail = nonSystem.slice(Math.max(0, nonSystem.length - RECENT_TAIL));

    if (toSummarize.length === 0) {
      if (changed.length === 0) return { compactionCount: 0 };
      return { messages: changed as BaseMessage[], compactionCount: 0 };
    }

    const conversationText = toSummarize
      .map((m) => {
        const role =
          m instanceof HumanMessage ? "User" : m instanceof AIMessage ? "Assistant" : "Tool";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      })
      .join("\n\n");

    const response = await model.invoke([
      new SystemMessage(COMPACTION_SYSTEM_PROMPT),
      new HumanMessage(`Summarize this conversation:\n\n${conversationText}`),
    ]);

    const rawSummary =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const summary = sanitize(rawSummary);
    const compactContext = new SystemMessage(`[Compacted conversation context]\n\n${summary}`);

    return {
      messages: [
        new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
        ...systemMsgs,
        compactContext,
        ...recentTail,
      ] as BaseMessage[],
      compactionCount: 0,
    };
  } catch (err) {
    console.error("[compaction_node] LLM compaction failed:", err);
    return {
      messages: changed.length > 0 ? (changed as BaseMessage[]) : [],
      compactionCount: compactionCount + 1,
    };
  }
}
