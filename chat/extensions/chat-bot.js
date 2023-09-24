
//import { Chat } from "jsdelivr.gh:ChatOnMac/chat-js@main/chat/modules/chat.js";
import { Chat } from "https://github.com/ChatOnMac/chat-js/blob/main/chat/modules/chat.js";

import { consoleProxy } from "jsdelivr.gh:ChatOnMac/chat-js@main/chat/modules/console-proxy.js";
import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "skypack:rxdb";
import { RxDBDevModePlugin } from "skypack:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "skypack:rxdb/plugins/replication";
import { getRxStorageMemory } from "skypack:rxdb/plugins/storage-memory";
import { BatchInterceptor } from 'skypack:mswjs/interceptors'
import browserInterceptors from 'skypack:mswjs/interceptors/presets/browser'


async function offerUnusedPersonas({ botsInRooms, unusedOnlineBots }) {
    if (unusedOnlineBots.length > 0) {
        return []
    }
    const botPersona = await this.db.collections["persona"].insert({
        id: crypto.randomUUID(),
        name: "ChatBOT",
        personaType: "bot",
        online: true,
        modelOptions: ["gpt-3.5-turbo", "gpt-4"],
        modifiedAt: new Date().getTime(),
    });
    return [botPersona];
}

const chat = await Chat.init({ offerUnusedPersonas });
window.chat = chat;

chat.addEventListener("finishedInitialSync", ({ db, replications }) => {
    db.collections["event"].insert$.subscribe(async ({ documentData, collectionName }) => {
        if (documentData.createdAt < EPOCH.getTime()) {
            return;
        }
        const personaCollection = db.collections["persona"];
        const persona = await personaCollection
            .findOne({
                selector: { id: documentData.sender },
            })
            .exec();
        if (persona?.personaType !== "user") {
            return;
        }

        // Build message history.
        const messages = await collection
            .find({
                selector: {
                    room: documentData.room,
                },
                limit: 10, // TODO: This is constrained by the model's token limit.
                sort: [{ createdAt: "desc" }],
            })
            .exec();

        const messageHistory = await Promise.all(
            messages.map(async ({ content, persona }) => {
                const foundPersona = await personaCollection
                    .findOne({ selector: { id: persona } })
                    .exec();
                return {
                    role:
                    foundPersona.personaType === "bot" ? "assistant" : "user",
                    content,
                };
            })
        );
        messageHistory.sort((a, b) => b - a);
        const room = await db.collections["room"].findOne(documentData.room).exec();
        const botPersonas = await getBotPersonas(room);
        const botPersona = botPersonas.length ? botPersonas[0] : null;
        if (!botPersona) {
            console.log("No matching bot to emit from.")
            return;
        }

        if (!botPersona.selectedModel) {
            botPersona.selectedModel = botPersona.modelOptions[0];
        }

        var systemPrompt = "";
        if (botPersona.customInstructionForContext || botPersona.customInstructionForReplies) {
            if (botPersona.customInstructionForContext) {
                systemPrompt += botPersona.customInstructionForContext.trim() + "\n\n"
            }
            if (botPersona.customInstructionForResponses) {
                systemPrompt += botPersona.customInstructionForResponses.trim() + "\n\n"
            }
        } else {
            systemPrompt = "You are a helpful assistant.";
        }
        systemPrompt = systemPrompt.trim();

        try {
            const resp = await fetch(
                "code://code/load/api.openai.com/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Chat-Trace-Event": documentData.id,
                    },
                    body: JSON.stringify({
                        model: botPersona.selectedModel,
                        temperature: botPersona.modelTemperature,
                        messages: [
                            {
                                role: "system",
                                content: systemPrompt,
                            },
                            ...messageHistory,
                            {
                                role: "user",
                                content: documentData.content,
                            },
                        ],
                    }),
                }
            );

            const data = await resp.json();

            if (!resp.ok) {
                 if (data.error.code === 'context_length_exceeded') {
                    
                 }

                throw new Error(data.error.message);
            }

            const content = data.choices[0].message.content;
            const createdAt = new Date().getTime();

            collection.insert({
                id: crypto.randomUUID(),
                content,
                type: "message",
                room: documentData.room,
                sender: botPersona.id,
                createdAt,
                modifiedAt: createdAt,
            });
        } catch (error) {
            var eventDoc = await db.collections["event"].findOne(documentData.id).exec();
            await eventDoc.incrementalModify((docData) => {
                docData.failureMessages = docData.failureMessages.concat(error);
                docData.retryablePersonaFailures = docData.retryablePersonaFailures.concat(botPersona.id);
                return docData;
            });
/*for (const replicationState of Object.values(state.replications)) {
replicationState.reSync();
await replicationState.awaitInSync();
}*/
        }
    });
});
