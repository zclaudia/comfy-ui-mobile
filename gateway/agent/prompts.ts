/**
 * Prompt text shared by every task. The workspace system prompt lives in `workspace/prompts.ts`; what remains here is
 * the completion check, which reviews a text-only answer before a task may finish.
 */
export const completionCheck = (request: string) => `Internal completion check for the latest request: ${JSON.stringify(request)}. Your previous text-only response is a candidate, not proof that actions happened. Check the actual tool results in this task. If any requested action remains, call the appropriate tool now. A promise such as "I will submit" is not completion. Do not repeat a successful preview. This review requires a tool call. If the request is already satisfied, call finish_response with the final answer in the user's language. If blocked, use finish_response to explain the actual blocker honestly. Never call finish_response alongside an action tool.`;
