import { AbortController } from "abort-controller";
import { pubsub_v1 } from "googleapis";
import { log } from "../log";
import {
    CALLID_ATTR,
    DeadLetterMessage,
    KIND_ATTR,
    Message,
    PollResult,
    ReceivableKind,
    ReceivableMessage
} from "../provider";
import { computeHttpResponseBytes, defined } from "../shared";
import { retryOp } from "../throttle";
import { Attributes } from "../types";
import { GoogleMetrics } from "./google-faast";
import PubSubApi = pubsub_v1;
import PubSubMessage = pubsub_v1.Schema$PubsubMessage;
import { deserializeMessage, serializeMessage } from "../serialize";

function pubsubMessageAttribute(message: PubSubMessage, attr: string) {
    return message?.attributes?.[attr];
}

export async function receiveMessages(
    pubsub: PubSubApi.Pubsub,
    subscription: string,
    metrics: GoogleMetrics,
    cancel: Promise<void>
): Promise<PollResult> {
    // Does higher message batching lead to better throughput? 10 is the max that AWS SQS allows.
    const maxMessages = 10;
    const source = new AbortController();
    const request = pubsub.projects.subscriptions.pull(
        {
            subscription,
            requestBody: { returnImmediately: false, maxMessages }
        },
        { signal: source.signal }
    );

    const response = await Promise.race([request, cancel]);
    if (!response) {
        source.abort();
        return { Messages: [] };
    }

    metrics.outboundBytes += computeHttpResponseBytes(response.headers);
    metrics.pubSubBytes +=
        computeHttpResponseBytes(response.headers, { httpHeaders: false, min: 1024 }) * 2;
    const Messages = response.data.receivedMessages || [];
    if (Messages.length > 0) {
        pubsub.projects.subscriptions.acknowledge({
            subscription,
            requestBody: {
                ackIds: Messages.map(m => m.ackId || "").filter(m => m !== "")
            }
        });
    }
    return {
        Messages: Messages.map(m => m.message!)
            .map(processMessage)
            .filter(defined),
        isFullMessageBatch: Messages.length === maxMessages
    };
}

function parseTimestamp(timestampStr: string | undefined) {
    return Date.parse(timestampStr || "") || 0;
}

function processMessage(m: PubSubMessage): ReceivableMessage | void {
    const kind = pubsubMessageAttribute(m, KIND_ATTR) as ReceivableKind;
    const callId = pubsubMessageAttribute(m, CALLID_ATTR);
    const timestamp = parseTimestamp(m.publishTime!);
    const data = m.data || "";
    const raw = Buffer.from(data, "base64").toString();

    switch (kind) {
        /* istanbul ignore next  */
        case "deadletter":
            log.warn("Not expecting deadletter message from google queue");
            return;
        case "functionstarted":
            if (!callId) {
                return;
            }
            return { kind, callId };
        case "response": {
            if (!callId || !m.data) {
                return;
            }
            const body = deserializeMessage(raw);
            return { kind, callId, body, rawResponse: m, timestamp };
        }
        case "cpumetrics":
            return deserializeMessage(raw);
    }
}

export async function publishPubSub(
    pubsub: PubSubApi.Pubsub,
    topic: string,
    message: string,
    attributes?: Attributes
) {
    const data = Buffer.from(message).toString("base64");

    await retryOp(3, () =>
        pubsub.projects.topics.publish({
            topic,
            requestBody: { messages: [{ data, attributes }] }
        })
    );
}

export function publishResponseMessage(
    pubsub: PubSubApi.Pubsub,
    ResponseQueue: string,
    message: Exclude<Message, DeadLetterMessage>
) {
    const kind = { [KIND_ATTR]: message.kind };
    switch (message.kind) {
        case "functionstarted":
            return publishPubSub(pubsub, ResponseQueue, "", {
                ...kind,
                [CALLID_ATTR]: message.callId
            });
        case "response":
            const body = serializeMessage(message.body);
            return publishPubSub(pubsub, ResponseQueue, body, {
                ...kind,
                [CALLID_ATTR]: message.callId
            });
        case "cpumetrics":
            return publishPubSub(pubsub, ResponseQueue, JSON.stringify(message), kind);
    }
}
