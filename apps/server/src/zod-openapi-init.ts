/**
 * Side-effect module: patches zod's ZodType prototype with `.openapi()`
 * (via zod-openapi's extendZodWithOpenApi) so schemas defined elsewhere -
 * notably CompletionBody/OpenAiMessage/ContentPart in openai.ts - can carry
 * OpenAPI metadata inline, right next to the validation rules they already
 * describe in prose comments. openapi-document.ts then derives the actual
 * /mirror/openapi document from those same schemas at request/startup time,
 * so the request/response *shape* in the generated spec can never drift
 * from what the server actually validates - there is no separate JSON
 * document to remember to update by hand.
 *
 * Must be imported (for its side effect) before any `.openapi(...)` call
 * runs. Every file that calls `.openapi()` imports this first.
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "zod-openapi";

extendZodWithOpenApi(z);
