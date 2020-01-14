import { Context, SNSEvent } from "aws-lambda";
import { SQS } from "aws-sdk";
import { env } from "process";
import { FaastError } from "../error";
import { ResponseMessage } from "../provider";
import { deserializeMessage } from "../serialize";
import {
    CallingContext,
    createErrorResponse,
    FunctionCallSerialized,
    FunctionReturnSerialized,
    Wrapper
} from "../wrapper";
import { sendResponseQueueMessage } from "./aws-queue";
import { getExecutionLogUrl } from "./aws-shared";

const sqs = new SQS();

export const filename = module.filename;

const CallIdAttribute: Extract<keyof FunctionCallSerialized, "callId"> = "callId";

function errorCallback(err: Error) {
    if (err.message.match(/SIGKILL/)) {
        return new FaastError(err, "possibly out of memory");
    }
    return err;
}

export function makeTrampoline(wrapper: Wrapper) {
    async function trampoline(
        event: FunctionCallSerialized | SNSEvent,
        context: Context,
        callback: (err: Error | null, obj: FunctionReturnSerialized) => void
    ) {
        const startTime = Date.now();
        const region = env.AWS_REGION!;
        sqs.config.region = region;
        context.callbackWaitsForEmptyEventLoop = false;
        const executionId = context.awsRequestId;
        const { logGroupName, logStreamName } = context;
        const logUrl = getExecutionLogUrl(
            region,
            logGroupName,
            logStreamName,
            executionId
        );
        const callingContext = {
            startTime,
            logUrl,
            executionId,
            instanceId: logStreamName
        };
        if (CallIdAttribute in event) {
            const sCall = event as FunctionCallSerialized;
            const { callId, ResponseQueueId: Queue } = sCall;
            const result = await wrapper.execute(
                { sCall, ...callingContext },
                {
                    onCpuUsage: metrics =>
                        sendResponseQueueMessage(sqs, Queue!, {
                            kind: "cpumetrics",
                            callId,
                            metrics
                        }),
                    errorCallback
                }
            );
            callback(null, result);
        } else {
            const snsEvent = event as SNSEvent;
            for (const record of snsEvent.Records) {
                const sCall: FunctionCallSerialized = deserializeMessage(
                    record.Sns.Message
                );
                const { callId, ResponseQueueId: Queue } = sCall;
                const startedMessageTimer = setTimeout(
                    () =>
                        sendResponseQueueMessage(sqs, Queue!, {
                            kind: "functionstarted",
                            callId
                        }),
                    2 * 1000
                );
                const cc: CallingContext = { sCall, ...callingContext };
                const result = await wrapper.execute(cc, {
                    onCpuUsage: metrics =>
                        sendResponseQueueMessage(sqs, Queue!, {
                            kind: "cpumetrics",
                            callId,
                            metrics
                        }),
                    errorCallback
                });
                clearTimeout(startedMessageTimer);
                const response: ResponseMessage = {
                    kind: "response",
                    callId,
                    body: result
                };
                return sendResponseQueueMessage(sqs, Queue!, response).catch(err => {
                    console.error(err);
                    const errResponse: ResponseMessage = {
                        kind: "response",
                        callId,
                        body: createErrorResponse(err, cc)
                    };
                    sendResponseQueueMessage(sqs, Queue!, errResponse).catch(_ => {});
                });
            }
        }
    }
    return { trampoline };
}
