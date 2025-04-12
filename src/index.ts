/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { fal } from '@fal-ai/client';

// Define the expected environment variables/secrets
interface Env {
	FAL_KEY: string; // Secret for Fal AI API
	API_KEY: string; // Secret for authenticating requests to this worker
}

// OpenAI Request/Response Types (Simplified)
interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | null;
}

interface OpenAIChatCompletionRequest {
	model: string;
	messages: OpenAIMessage[];
	stream?: boolean;
	// We can add other OpenAI parameters here if needed, but keep them simple for now
	// e.g., max_tokens, temperature, etc.
	reasoning_effort?: 'low' | 'medium' | 'high'; // New param compatible with OpenAI reasoning
}

// Type for supported Fal Model IDs based on the constant array
// This ensures type safety when passing to the fal client
type FalModelId = typeof FAL_SUPPORTED_MODELS[number];

interface FalInput {
	model: FalModelId; // Use the specific type
	prompt: string;
	system_prompt?: string;
	reasoning?: boolean;
	// Fal-specific parameters can be added here if needed
}

// Simple type for log entries in the stream
interface LogEntry {
	message: string;
	level?: string; // Optional level property
}

// Type for Fal Stream Event Data
interface FalStreamEventData {
    output: string;
    reasoning?: any; // Or a more specific type if known
    partial?: boolean;
    error?: any; // Or a more specific type if known
    logs?: LogEntry[];
}

// Type for Fal Stream Event
interface FalStreamEvent {
	output: string;
    reasoning?: any; // Or a more specific type if known
    partial?: boolean;
    error?: any; // Or a more specific type if known
    logs?: LogEntry[];
	// Other potential properties from the stream event can be added here
}

// Type for Fal Subscribe Result
interface FalSubscribeResult {
	data: FalStreamEventData;
	requestId: string;
	// Other potential top-level properties can be added here
}

// === Global Definitions ===
const PROMPT_LIMIT = 4800;
const SYSTEM_PROMPT_LIMIT = 4800;

const FAL_SUPPORTED_MODELS = [
	"anthropic/claude-3.7-sonnet",
	"anthropic/claude-3.5-sonnet",
	"anthropic/claude-3-5-haiku",
	"anthropic/claude-3-haiku",
	"google/gemini-pro-1.5",
	"google/gemini-flash-1.5",
	"google/gemini-flash-1.5-8b",
	"google/gemini-2.0-flash-001",
	"meta-llama/llama-3.2-1b-instruct",
	"meta-llama/llama-3.2-3b-instruct",
	"meta-llama/llama-3.1-8b-instruct",
	"meta-llama/llama-3.1-70b-instruct",
	"openai/gpt-4o-mini",
	"openai/gpt-4o",
	"deepseek/deepseek-r1",
	"meta-llama/llama-4-maverick",
	"meta-llama/llama-4-scout"
] as const; // Use 'as const' for stricter type checking

// Helper function to get owner from model ID
const getOwner = (modelId: string): string => {
	if (modelId && modelId.includes('/')) {
		return modelId.split('/')[0];
	}
	return 'fal-ai'; // Default owner
};

// === Message Conversion Logic (Adapted from JS) ===
function convertMessagesToFalPrompt(messages: OpenAIMessage[]): { system_prompt: string; prompt: string } {
	let fixed_system_prompt_content = "";
	const conversation_message_blocks: string[] = [];
	console.log(`Original messages count: ${messages.length}`);

	for (const message of messages) {
		let content = (message.content === null || message.content === undefined) ? "" : String(message.content);
		switch (message.role) {
			case 'system':
				fixed_system_prompt_content += `System: ${content}\n\n`;
				break;
			case 'user':
				conversation_message_blocks.push(`Human: ${content}\n\n`);
				break;
			case 'assistant':
				conversation_message_blocks.push(`Assistant: ${content}\n\n`);
				break;
			default:
				console.warn(`Unsupported role: ${message.role}`);
				continue;
		}
	}

	if (fixed_system_prompt_content.length > SYSTEM_PROMPT_LIMIT) {
		const originalLength = fixed_system_prompt_content.length;
		fixed_system_prompt_content = fixed_system_prompt_content.substring(0, SYSTEM_PROMPT_LIMIT);
		console.warn(`Combined system messages truncated from ${originalLength} to ${SYSTEM_PROMPT_LIMIT}`);
	}
	fixed_system_prompt_content = fixed_system_prompt_content.trim();

	let space_occupied_by_fixed_system = 0;
	if (fixed_system_prompt_content.length > 0) {
		space_occupied_by_fixed_system = fixed_system_prompt_content.length + 4; // Approx space for separator
	}
	const remaining_system_limit = Math.max(0, SYSTEM_PROMPT_LIMIT - space_occupied_by_fixed_system);
	console.log(`Trimmed fixed system prompt length: ${fixed_system_prompt_content.length}. Approx remaining system history limit: ${remaining_system_limit}`);

	const prompt_history_blocks: string[] = [];
	const system_prompt_history_blocks: string[] = [];
	let current_prompt_length = 0;
	let current_system_history_length = 0;
	let promptFull = false;
	let systemHistoryFull = (remaining_system_limit <= 0);

	console.log(`Processing ${conversation_message_blocks.length} user/assistant messages for recency filling.`);
	for (let i = conversation_message_blocks.length - 1; i >= 0; i--) {
		const message_block = conversation_message_blocks[i];
		const block_length = message_block.length;

		if (promptFull && systemHistoryFull) {
			console.log(`Both prompt and system history slots full. Omitting older messages from index ${i}.`);
			break;
		}

		if (!promptFull) {
			if (current_prompt_length + block_length <= PROMPT_LIMIT) {
				prompt_history_blocks.unshift(message_block);
				current_prompt_length += block_length;
				continue;
			} else {
				promptFull = true;
				console.log(`Prompt limit (${PROMPT_LIMIT}) reached. Trying system history slot.`);
			}
		}

		if (!systemHistoryFull) {
			if (current_system_history_length + block_length <= remaining_system_limit) {
				 system_prompt_history_blocks.unshift(message_block);
				 current_system_history_length += block_length;
				 continue;
			} else {
				 systemHistoryFull = true;
				 console.log(`System history limit (${remaining_system_limit}) reached.`);
			}
		}
	}

	const system_prompt_history_content = system_prompt_history_blocks.join('').trim();
	const final_prompt = prompt_history_blocks.join('').trim();
	const SEPARATOR = "\n\n-------下面是比较早之前的对话内容-----\n\n";
	let final_system_prompt = "";
	const hasFixedSystem = fixed_system_prompt_content.length > 0;
	const hasSystemHistory = system_prompt_history_content.length > 0;

	if (hasFixedSystem && hasSystemHistory) {
		final_system_prompt = fixed_system_prompt_content + SEPARATOR + system_prompt_history_content;
		console.log("Combining fixed system prompt and history with separator.");
	} else if (hasFixedSystem) {
		final_system_prompt = fixed_system_prompt_content;
		console.log("Using only fixed system prompt.");
	} else if (hasSystemHistory) {
		final_system_prompt = system_prompt_history_content;
		console.log("Using only history in system prompt slot.");
	}

	const result = {
		system_prompt: final_system_prompt,
		prompt: final_prompt
	};

	console.log(`Final system_prompt length: ${result.system_prompt.length}`);
	console.log(`Final prompt length: ${result.prompt.length}`);
	return result;
}

// Type guard to check if a string is a valid FalModelId
function isValidFalModelId(modelId: string): modelId is FalModelId {
	return (FAL_SUPPORTED_MODELS as readonly string[]).includes(modelId);
}

// === Main Fetch Handler ===
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const corsHeaders = { 'Access-Control-Allow-Origin': '*' }; // Basic CORS header

		// Handle CORS preflight requests (OPTIONS)
		if (method === 'OPTIONS') {
			 return new Response(null, {
				 headers: {
					 ...corsHeaders,
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Authorization, Content-Type',
				}
			});
		}

		// --- Authentication & Fal Client Config --- (Run for all relevant endpoints)
		if (path.startsWith('/v1/')) { // Only process /v1 routes
			const authHeader = request.headers.get('Authorization');
			const expectedApiKey = env.API_KEY;

			if (!expectedApiKey) {
				console.error("API_KEY secret is not set.");
				return new Response(JSON.stringify({ error: { message: 'Server configuration error: API Key missing.', type: 'server_error' } }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}
			if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.substring(7) !== expectedApiKey) {
				console.error(`Auth failed. Header: ${authHeader ? 'Present' : 'Missing'}, Token comparison: ${authHeader?.substring(7) === expectedApiKey}`);
				return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key'} }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}

			// Configure Fal client (only if auth passes)
			if (!env.FAL_KEY) {
				console.error("FAL_KEY secret is not set.");
				return new Response(JSON.stringify({ error: { message: 'Server configuration error: Fal Key missing.', type: 'server_error'} }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}
			try {
				// Ensure config is called only once per request if needed, though subsequent calls are generally safe
				fal.config({ credentials: env.FAL_KEY });
			} catch (error: any) {
				 console.error("Failed to configure Fal client:", error);
				 return new Response(JSON.stringify({ error: { message: `Failed to initialize Fal client: ${error.message}`, type: 'server_error'} }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}
		} else if (path === '/') {
			// Allow root path without auth
		} else {
			// Any other path is Not Found
			return new Response(JSON.stringify({ error: { message: `Invalid path: ${path}`, type: 'invalid_request_error'} }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
		}

		// --- Routing --- 

		// GET /v1/models
		if (method === 'GET' && path === '/v1/models') {
			try {
				const modelsData = FAL_SUPPORTED_MODELS.map(modelId => ({
					id: modelId,
					object: "model",
					created: Math.floor(Date.now() / 1000),
					owned_by: getOwner(modelId)
				}));
				return new Response(JSON.stringify({ object: "list", data: modelsData }), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders } // Add CORS
				});
			} catch (error: any) {
				console.error("Error processing GET /v1/models:", error);
				return new Response(JSON.stringify({ error: { message: `Failed to retrieve model list: ${error.message}`, type: 'server_error'} }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}
		}

		// POST /v1/chat/completions
		if (method === 'POST' && path === '/v1/chat/completions') {
			let requestBody: OpenAIChatCompletionRequest;
			try {
				requestBody = await request.json();
			} catch (error) {
				return new Response(JSON.stringify({ error: { message: 'Invalid JSON request body', type: 'invalid_request_error'} }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}

			const { model: requestedModel, messages, stream = false, reasoning_effort } = requestBody;

			if (!requestedModel || !messages || !Array.isArray(messages) || messages.length === 0) {
				return new Response(JSON.stringify({ error: { message: 'Missing or invalid parameters: model and messages array are required.', type: 'invalid_request_error'} }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}
			// Optionally validate model format here if needed

			// Validate and determine the model to use
			let modelToUse: FalModelId;
			if (isValidFalModelId(requestedModel)) {
				modelToUse = requestedModel;
			} else {
				console.error(`Error: Requested model '${requestedModel}' is not supported.`);
				return new Response(JSON.stringify({
					error: {
						message: `The model \`${requestedModel}\` does not exist or is not supported by this endpoint.`,
						type: 'invalid_request_error',
						param: 'model',
						code: 'model_not_found'
					}
				}), {
					status: 400, // Bad Request for invalid model parameter
					headers: { 'Content-Type': 'application/json', ...corsHeaders }
				});
			}

			// Determine if reasoning should be requested from Fal based on reasoning_effort
			const shouldRequestReasoning = !!reasoning_effort && ['low', 'medium', 'high'].includes(reasoning_effort);

			try {
				const { prompt, system_prompt } = convertMessagesToFalPrompt(messages);
				const falInput: FalInput = {
					model: modelToUse,
					prompt: prompt,
					reasoning: shouldRequestReasoning, // Set Fal's reasoning based on reasoning_effort
				};
				if (system_prompt) {
					falInput.system_prompt = system_prompt;
				}

				console.log(`Forwarding request to fal-ai/any-llm. Model: ${falInput.model}, Stream: ${stream}, Reasoning Effort: ${reasoning_effort ?? 'none'} -> Fal Reasoning: ${falInput.reasoning}`);

				if (stream) {
					// --- Stream Handling using @fal-ai/client ---
					console.log("Executing streaming request...");
					try {
                        // Prepare payload for logging
                        const falStreamPayload = {
                            input: falInput as any // Type assertion to bypass TypeScript error
                            // Add other stream-specific options here if any are used
                        };
                        console.log("Sending payload to fal.stream:", JSON.stringify(falStreamPayload, null, 2)); // Log the payload

						// Set up streaming response
						const encoder = new TextEncoder();
						const { readable, writable } = new TransformStream();
						const writer = writable.getWriter();
						let previousOutput = '';

						// Use ctx.waitUntil to allow the stream processing to continue after the response is returned
						ctx.waitUntil((async () => {
							let falStream = null;
							try {
								console.log("Initiating fal.stream...");
								// Use the prepared payload object
								falStream = await fal.stream("fal-ai/any-llm", falStreamPayload);
								console.log("fal.stream initiated.");

								for await (const event of falStream) {
									// console.log("Fal Stream Event:", event); // Verbose stream logging
									const currentOutput = (event && typeof event.output === 'string') ? event.output : '';
									const isPartial = (event && typeof event.partial === 'boolean') ? event.partial : true;
									const errorInfo = (event && event.error) ? event.error : null;
									const logs = (event && Array.isArray((event as any).logs)) ? (event as any).logs : [];
									const reasoningData = (event && event.reasoning) ? event.reasoning : null; // Extract reasoning data
									// Log messages from Fal with explicit type
									logs.forEach((log: LogEntry) => console.log(`[Fal Log] ${log.message}`));

									if (errorInfo) {
										console.error("Error received in fal stream event:", errorInfo);
										const errorChunk = { id: `chatcmpl-${Date.now()}-error`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: "error", logprobs: null, message: { role: 'assistant', content: `Fal Stream Error: ${JSON.stringify(errorInfo)}` } }] };
										await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
										throw new Error(`Fal Stream Error: ${JSON.stringify(errorInfo)}`); // Throw to trigger catch block
									}

									let deltaContent = '';
									if (currentOutput.startsWith(previousOutput)) {
										deltaContent = currentOutput.substring(previousOutput.length);
									} else if (currentOutput.length > 0) {
										console.warn("Fal stream output mismatch. Sending full current output as delta.");
										deltaContent = currentOutput;
										previousOutput = ''; // Reset if mismatch
									}
									// Always update previousOutput if currentOutput is not empty, even if deltaContent is empty
									if(currentOutput.length > 0) {
										previousOutput = currentOutput;
									}

									// Send chunk if there's new content, reasoning data, or it's the final chunk
									if (deltaContent || reasoningData || !isPartial) {
										const choice = {
											index: 0,
											delta: { content: deltaContent },
											finish_reason: isPartial === false ? "stop" : null,
											logprobs: null,
											// Include reasoning if present in this event
											...(reasoningData && { reasoning: [{ index: 0, content: reasoningData }] })
										};

										const openAIChunk = {
											id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
											object: "chat.completion.chunk",
											created: Math.floor(Date.now() / 1000),
											model: requestedModel, // Report the originally requested model
											choices: [choice]
										};
										await writer.write(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
									}
									// Add a small delay if needed to prevent overwhelming the writer, though usually not necessary
									// await new Promise(resolve => setTimeout(resolve, 5));
								}
								console.log("Fal stream iteration finished successfully.");
								// Send DONE marker after successful completion
								await writer.write(encoder.encode(`data: [DONE]\n\n`));

							} catch (streamError: any) {
								console.error('Error during fal stream processing:', streamError);
								 try {
									const errorDetails = (streamError instanceof Error) ? streamError.message : JSON.stringify(streamError);
									const errorChunk = { error: { message: "Stream processing error", type: "proxy_error", param: null, code: null, details: errorDetails } };
									await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
									// Ensure DONE is sent even after an error during processing
									await writer.write(encoder.encode(`data: [DONE]\n\n`));
								} catch (writeError) {
									console.error("Error writing final stream error message:", writeError);
								}
							} finally {
								// Close the writer in the finally block to ensure it always happens
								try {
									console.log("Closing stream writer...");
									await writer.close();
									console.log("Stream writer closed.");
								} catch (closeError) {
									console.error("Error closing stream writer:", closeError);
								}
							}
						})()); // End of ctx.waitUntil

						return new Response(readable, {
							headers: {
								'Content-Type': 'text/event-stream; charset=utf-8',
								'Cache-Control': 'no-cache',
								'Connection': 'keep-alive',
								'Access-Control-Allow-Origin': '*' // Adjust CORS as needed
							}
						});

					} catch (error: any) {
						console.error("Error during fal-ai request processing:", error);
						return new Response(JSON.stringify({ error: { message: `Error processing request: ${error.message}`, type: 'server_error' } }),
							{ status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
					}
				} else {
					// --- Non-Stream Handling using @fal-ai/client ---
					console.log("Executing non-stream request...");
					try {
                        // Prepare payload for logging
                        const falSubscribePayload = {
                            input: falInput as any // Type assertion to bypass TypeScript error
                            // Add other subscribe-specific options here if any are used
                        };
                        console.log("Sending payload to fal.subscribe:", JSON.stringify(falSubscribePayload, null, 2)); // Log the payload

						// Use the prepared payload object
						const result = await fal.subscribe("fal-ai/any-llm", falSubscribePayload) as FalSubscribeResult;

						// Log the raw result for debugging
						console.log("Raw non-stream result from fal-ai:", JSON.stringify(result, null, 2));

						// Check for errors within the data object
						if (result?.data?.error) {
							console.error("Fal-ai returned an error in non-stream mode:", result.data.error);
							return new Response(JSON.stringify({ object: "error", message: `Fal-ai error: ${JSON.stringify(result.data.error)}`, type: "fal_ai_error" }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
						}

						// Log any messages from non-streaming response (assuming logs might be in data)
						if (result?.data?.logs && Array.isArray(result.data.logs)) {
							result.data.logs.forEach((log: LogEntry) => console.log(`[Fal Log] ${log.message}`));
						}

						// Access properties correctly from the data object
						const outputContent = result?.data?.output ?? "";
						const reasoningData = result?.data?.reasoning; // Get reasoning data
						const reqId = result?.requestId || Date.now().toString(); // Use correct requestId

						const openAIResponse = {
							id: `chatcmpl-${reqId}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: requestedModel, // Report the originally requested model
							choices: [{
								index: 0,
								message: {
									role: "assistant",
									content: outputContent
								},
								finish_reason: "stop",
								logprobs: null,
								// Include reasoning if present in the result
								...(reasoningData && { reasoning: [{ index: 0, content: reasoningData }] })
							}],
							usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }, // Usage data might be available from Fal in the future
							system_fingerprint: null,
						};
						return new Response(JSON.stringify(openAIResponse), {
							 headers: { 'Content-Type': 'application/json', ...corsHeaders } // Add CORS
						});

					} catch (falError: any) {
						console.error('Error calling fal.subscribe:', falError);
						const errorMessage = (falError instanceof Error) ? falError.message : JSON.stringify(falError);
						return new Response(JSON.stringify({ error: { message: `Error from Fal: ${errorMessage}`, type: 'fal_api_error' } }),
							{ status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
					}
				}
			} catch (error: any) {
				console.error("Error during fal-ai request processing:", error);
				return new Response(JSON.stringify({ error: { message: `Error processing request: ${error.message}`, type: 'server_error' } }),
					{ status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
			}
		}

		// Default response for root path or other unhandled routes
		return new Response(JSON.stringify({ status: 'ok', message: 'Fal AI-powered OpenAI Proxy API' }), 
			{ headers: { 'Content-Type': 'application/json', ...corsHeaders } });
	}
};