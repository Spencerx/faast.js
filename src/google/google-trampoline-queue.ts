import { google, pubsub_v1 } from "googleapis";
import { deserializeMessage } from "../serialize";
import { createErrorResponse, FunctionCallSerialized, Wrapper } from "../wrapper";
import { publishResponseMessage } from "./google-queue";
import { getExecutionLogUrl, shouldRetryRequest } from "./google-shared";
import PubSubApi = pubsub_v1;

export const filename = module.filename;

export interface CloudFunctionContext {
    eventId: string;
    timestamp: string;
    eventType: string;
    resource: object;
}

let pubsub: PubSubApi.Pubsub;
type PubsubMessage = PubSubApi.Schema$PubsubMessage;

async function initialize() {
    if (!pubsub) {
        const auth = await google.auth.getClient({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"]
        });
        google.options({
            auth,
            retryConfig: {
                retry: 3,
                noResponseRetries: 3,
                shouldRetry: shouldRetryRequest(console.log)
            }
        });
        pubsub = google.pubsub("v1");
    }
}

export function makeTrampoline(wrapper: Wrapper) {
    async function trampoline(data: PubsubMessage, context: CloudFunctionContext) {
        const startTime = Date.now();
        await initialize();

        const executionId = context.eventId;
        const project = process.env["GCP_PROJECT"]!;
        const functionName = process.env["FUNCTION_NAME"]!;
        const logUrl = getExecutionLogUrl(project, functionName, executionId);
        const str = Buffer.from(data.data!, "base64");
        const sCall: FunctionCallSerialized = deserializeMessage(str.toString());

        const { callId, ResponseQueueId } = sCall;
        const startedMessageTimer = setTimeout(
            () =>
                publishResponseMessage(pubsub, ResponseQueueId!, {
                    kind: "functionstarted",
                    callId
                }),
            2 * 1000
        );

        const callingContext = {
            sCall,
            startTime,
            logUrl,
            executionId
        };

        try {
            const deadline =
                Date.parse(context.timestamp) + wrapper.options.childProcessTimeoutMs;
            const result = await wrapper.execute(callingContext, {
                onCpuUsage: metrics =>
                    publishResponseMessage(pubsub, ResponseQueueId!, {
                        kind: "cpumetrics",
                        callId,
                        metrics
                    }),
                overrideTimeout: deadline - Date.now()
            });
            clearTimeout(startedMessageTimer);
            await publishResponseMessage(pubsub, sCall.ResponseQueueId!, {
                kind: "response",
                callId,
                body: result
            });
        } catch (err) {
            /* istanbul ignore next */
            {
                console.error(err);
                if (ResponseQueueId) {
                    await publishResponseMessage(pubsub, sCall.ResponseQueueId!, {
                        kind: "response",
                        callId,
                        body: createErrorResponse(err, callingContext)
                    });
                }
            }
        }
    }
    return { trampoline };
}
