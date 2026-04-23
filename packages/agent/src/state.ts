import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  compactionCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});
