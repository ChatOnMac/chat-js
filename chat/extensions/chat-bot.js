// This will be cleaned up for easier reuse soon. --ChatOnMac

// import { Chat } from "jsdelivr.gh:ChatOnMac/chat-js@4f2b0a3/chat/modules/chat.js";
// import { Chat } from "https://github.com/ChatOnMac/chat-js/blob/main/chat/modules/chat.js";

// Copied from module for import map rigging... temporary hack.
// Dev Mode:
//addRxPlugin(RxDBDevModePlugin);

// From: https://github.com/kofrasa/mingo/tree/49f6f98e2432c9f389cd65e4a7e27f4e004c6a26#loading-operators
// Note that doing this effectively imports the entire library into your bundle and unused operators cannot be tree shaked
//import "esm.run:mingo/init/system";
// This will be cleaned up for easier reuse soon. --ChatOnMac

// import { Chat } from "jsdelivr.gh:ChatOnMac/chat-js@4f2b0a3/chat/modules/chat.js";
// import { Chat } from "https://github.com/ChatOnMac/chat-js/blob/main/chat/modules/chat.js";

// Copied from module for import map rigging... temporary hack.
// Dev Mode:
//addRxPlugin(RxDBDevModePlugin);

// From: https://github.com/kofrasa/mingo/tree/49f6f98e2432c9f389cd65e4a7e27f4e004c6a26#loading-operators
// Note that doing this effectively imports the entire library into your bundle and unused operators cannot be tree shaked
//import "esm.run:mingo/init/system";

// This will be cleaned up for easier reuse soon. --ChatOnMac

// import { proxyConsole } from "jsdelivr.gh:ChatOnMac/chat-js@main/chat/modules/console-proxy.js";

import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "npm:rxdb";
import { RxDBDevModePlugin } from "npm:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "npm:rxdb/plugins/replication";
import { getRxStorageMemory } from "npm:rxdb/plugins/storage-memory";
import { createDeferredExecutor } from "esm.run:@open-draft/deferred-promise";
import { until } from "esm.run:@open-draft/until";
import { Emitter } from "esm.run:strict-event-emitter";
import { Logger } from "esm.run:@open-draft/logger";
import { invariant } from "esm.run:outvariant";
import { isNodeProcess } from "esm.run:is-node-process";
import { BatchInterceptor } from 'esm.run:@mswjs/interceptors@0.25.4';
import browserInterceptors from 'esm.run:@mswjs/interceptors@0.25.4/lib/browser/presets/browser.mjs';
import { encodeChat, isWithinTokenLimit } from 'npm:gpt-tokenizer';

// addRxPlugin(RxDBDevModePlugin);
function installNativeHostBehaviors() {
    const interceptor = new BatchInterceptor({
        name: 'my-interceptor',
        interceptors: browserInterceptors,
    })
    interceptor.on('request', listener)
}

/**
 * The conflict handler gets 3 input properties:
 * - assumedMasterState: The state of the document that is assumed to be on the master branch
 * - newDocumentState: The new document state of the fork branch (=client) that RxDB want to write to the master
 * - realMasterState: The real master state of the document
 */
function conflictHandler(i) {
    /**
     * Here we detect if a conflict exists in the first place.
     * If there is no conflict, we return isEqual=true.
     * If there is a conflict, return isEqual=false.
     * In the default handler we do a deepEqual check,
     * but in your custom conflict handler you probably want
     * to compare specific properties of the document, like the updatedAt time,
     * for better performance because deepEqual() is expensive.
     */
    if (deepEqual(
        i.newDocumentState,
        i.realMasterState
    )) {
        return Promise.resolve({
            isEqual: true
        });
    }

    /**
     * If a conflict exists, we have to resolve it.
     * The default conflict handler will always
     * drop the fork state and use the master state instead.
     * 
     * In your custom conflict handler you likely want to merge properties
     * of the realMasterState and the newDocumentState instead.
     */
    return Promise.resolve({
        isEqual: false,
        documentData: i.newDocumentState.modifiedAt > i.realMasterState.modifiedAt ? i.realMasterState : i.newDocumentState,
    });
}

class ChatParentBridge {
    db;
    state;
    onFinishedSyncingDocsFromCanonical;

    constructor ({ db, state, onFinishedSyncingDocsFromCanonical }) {
        this.db = db;
        this.state = state;
        this.onFinishedSyncingDocsFromCanonical = onFinishedSyncingDocsFromCanonical;
    }

    async createReplicationState(collection) {
        const { name: collectionName } = collection;
    
        const pullHandler = async (lastCheckpoint, batchSize) => {
            // console.log("Called pull handler with: ", lastCheckpoint, batchSize);

            const canonicalDocumentChangesKey =
                this.getCanonicalDocumentChangesKey(collectionName);
            var documents = [];
            for (let i = 0; i < batchSize; i++) {
                const el = (this.state.canonicalDocumentChanges[canonicalDocumentChangesKey] || []).shift();
                if (el) {
                    documents.push(el);
                } else {
                    break;
                }
            }

            const checkpoint =
                documents.length === 0
                    ? lastCheckpoint
                    : {
                        id: lastOfArray(documents).id,
                        modifiedAt: lastOfArray(documents).modifiedAt,
                    };

            window[`${collectionName}LastCheckpoint`] = checkpoint;

            return {
                documents,
                checkpoint,
            };
        };

        const replicationState = replicateRxCollection({
            collection,
            replicationIdentifier: `${collectionName}-replication`,
            live: true,
            retryTime: 5 * 1000,
            waitForLeadership: true,
            autoStart: true,
    
            deletedField: "isDeleted",
    
            push: {
                async handler(docs) {
                    //console.log("Called push handler with: ", docs);
                    window.webkit.messageHandlers.surrogateDocumentChanges.postMessage({
                        collectionName: collection.name,
                        changedDocs: docs.map((row) => {
                            return row.newDocumentState;
                        }),
                    });
    
                    return [];
                },
                batchSize: 50,
                modifier: (doc) => doc,
            },
    
            pull: {
                handler: pullHandler.bind(this),
                batchSize: 10,
                modifier: (doc) => doc,
            },
        });
    
        return replicationState;
    }

    getReplicationStateKey(collectionName) {
        return `${collectionName}ReplicationState`;
    }
    
    getCanonicalDocumentChangesKey(collectionName) {
        return `${collectionName}CanonicalDocumentChanges`;
    }
    
    async createCollectionsFromCanonical(collections) {
        for (const [collectionName, collection] of Object.entries(collections)) {
            collections[collectionName]["conflictHandler"] = conflictHandler;
        }
        await this.db.addCollections(collections);

        const collectionEntries = Object.entries(this.db.collections);
        for (const [collectionName, collection] of collectionEntries) {
            const replicationState = await this.createReplicationState(collection);
            const replicationStateKey = this.getReplicationStateKey(collectionName);
            this.state.replications[replicationStateKey] = replicationState;
        }

        for (const replicationState of Object.values(this.state.replications)) {
            replicationState.reSync();
            await replicationState.awaitInSync();
        }
    }

    async syncDocsFromCanonical(collectionName, changedDocs) {
        const replicationStateKey = this.getReplicationStateKey(collectionName);
        const replicationState = this.state.replications[replicationStateKey];
    
        const canonicalDocumentChangesKey =
            this.getCanonicalDocumentChangesKey(collectionName);
    
        if (!this.state.canonicalDocumentChanges[canonicalDocumentChangesKey]) {
            this.state.canonicalDocumentChanges[canonicalDocumentChangesKey] = [];
        }
        this.state.canonicalDocumentChanges[canonicalDocumentChangesKey].push(...changedDocs);
    
        replicationState.reSync();
        await replicationState.awaitInSync();
    }

    async replicationInSync() {
        for (const replicationState of Object.values(this.state.replications)) {
            replicationState.reSync();
            await replicationState.awaitInSync();
        }
    }

    async finishedSyncingDocsFromCanonical() {
        for (const replicationState of Object.values(this.state.replications)) {
            replicationState.reSync();
        }
        await this.replicationInSync()
    
        await this.onFinishedSyncingDocsFromCanonical();
    }
}

class Chat extends EventTarget {
    db;
    parentBridge;

    onlineAt = new Date();
    state = { replications: {}, canonicalDocumentChanges: {} };

    tokenLimits = {
        "gpt-4": 8192,
        "gpt-4-0314": 8192,
        "gpt-4-0613": 8192,
        "gpt-4-32k": 32768,
        "gpt-4-32k-0613": 32768,
        "gpt-4-32k-0314": 32768,
        "gpt-3.5-turbo": 4097,
        "gpt-3.5-turbo-instruct": 4097,
        "gpt-3.5-turbo-0613": 4097,
        "gpt-3.5-turbo-0301": 4097,
        "gpt-3.5-turbo-16k": 16385,
        "gpt-3.5-turbo-16k-0613": 16385,
    };

    constructor ({ db }) {
        super();
        this.db = db;
        const onFinishedSyncingDocsFromCanonical = this.onFinishedSyncingDocsFromCanonical.bind(this);
        this.parentBridge = new ChatParentBridge({ db, state: this.state, onFinishedSyncingDocsFromCanonical, dispatchEvent: this.dispatchEvent });
    }

    async onFinishedSyncingDocsFromCanonical() {
        this.dispatchEvent(new CustomEvent("finishedInitialSync", { detail: { db: this.db, replications: this.state.replications } }));
        await this.keepOwnPersonasOnline();
        // this.offerUnusedPersonas = this.offerUnusedPersonas.bind(this);
        // await this.offerUnusedPersonas();
        // this.dispatchEvent(new CustomEvent("offerUnusedPersonas", { detail: { } }));
        await this.wireUnusedPersonas();
    }

    static async init() {
        // proxyConsole();

        const db = await createRxDatabase({
            name: "chat",
            storage: getRxStorageMemory(),
            eventReduce: true,
            multiInstance: false, // Change this when ported to web etc.
        });

        // Invoke the private constructor...
        const chat = new Chat({ db });
        return chat;
    }

    async dispatchUnusedPersonasEvent(rooms) {
        var rooms = rooms || await this.db.collections.room.find().exec();
        const botsInRoomsIDs = [...new Set(rooms.flatMap(room => room.participants))];
        var botsInRooms = await this.db.collections.persona.findByIds(botsInRoomsIDs).exec();
        botsInRooms = [...botsInRooms.values()];
        const unusedOnlineBots = await this.db.collections.persona.find({ selector: { online: true, id: { $not: { $in: botsInRoomsIDs } } } }).exec();
        this.dispatchEvent(new CustomEvent("offerUnusedPersonas", { detail: { db: this.db, botsInRooms, unusedOnlineBots } }));
    }

    async wireUnusedPersonas() {
        if (this.db.collections.length === 0) { return }
        await this.db.collections.room.$.subscribe(async rooms => {
            this.dispatchUnusedPersonasEvent();
        });
        await this.db.collections.persona.$.subscribe(async personas => {
            this.dispatchUnusedPersonasEvent();
        });
        this.dispatchUnusedPersonasEvent();
    }

    async ownPersonas(insideRoomsOnly) {
        // TODO: Multiple bots in same room.
        const botPersonas = await this.getBotPersonas(null, insideRoomsOnly);
        return botPersonas
    }
    
    async keepOwnPersonasOnline() {
        if (this.db.collections.length === 0) { return }
        const botPersonas = await this.ownPersonas(true);
        for (const botPersona of botPersonas) {
            if (!botPersona.online) {
                // Refresh instance (somehow stale otherwise).
                let bot = await this.db.collections.persona.findOne(botPersona.id).exec();
                await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
            }
            // TODO: unsubscribe too is necessary with rxdb
            botPersona.online$.subscribe(async online => {
                if (!online) {
                    // Refresh instance (somehow stale otherwise).
                    let bot = await this.db.collections.persona.findOne(botPersona.id).exec();
                    await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
                }
            });
        }
    }

    async getBotPersonas(room, insideRoomsOnly) {
        if (this.db.collections.length === 0) { return }
        let extension = await this.db.collections["code_extension"].findOne().exec();
        let botPersonas = await this.getProvidedBotsIn(extension, room, insideRoomsOnly);
        return botPersonas;
    }

    async getProvidedBotsIn(extension, room, insideRoomsOnly) {
        if (this.db.collections.length === 0) { return [] }
        var bots = [];
        if (room && room.participants && room.participants.length > 0) {
            let allInRoomMap = await this.db.collections.persona.findByIds(room.participants).exec();
            for (const participant of allInRoomMap.values()) {
                if (participant.providedByExtension === extension.id && participant.personaType === "bot") {
                    bots.push(participant);
                }
            }
        } else if (insideRoomsOnly) {
            let allRooms = await this.db.collections.room.find().exec();
            for (const otherRoom of allRooms) {
                const botPersonas = await this.getProvidedBotsIn(extension, otherRoom, insideRoomsOnly);
                if (botPersonas.length > 0) {
                    bots.push(...botPersonas);
                }
            }
        } else if (!insideRoomsOnly) {
            const extensionBots = await this.db.collections.persona.find({ selector: { providedByExtension: extension.id, personaType: "bot" } }).exec();
            return [...extensionBots];
        }
        return bots;
    }

    async getMessageHistory({ room, limit }) {
        // Build message history.
        const messages = await this.db.collections.event
            .find({
                selector: { room: room },
                limit: limit,
                sort: [{ createdAt: "desc" }],
            })
            .exec();
        return messages.reversed();
    }

    async getMessageHistoryJSON(args) {
        const history = await this.getMessageHistory(args);
        const json = await Promise.all(
            history.map(async ({ content, persona }) => {
                const foundPersona = await personaCollection
                    .findOne(persona)
                    .exec();
                return {
                    role:
                    foundPersona.personaType === "bot" ? "assistant" : "user",
                    content,
                };
            })
        );
        return json
    }

    async retryableOpenAIChatCompletion({ botPersona, room, content, messageHistoryLimit }) {
        var systemPrompt = "You are " + botPersona.name + ", a large language model trained by OpenAI, based on the " + botPersona.selectedModel + " architecture. Knowledge cutoff: 2022-01 Current date: " + (new Date()).toString() + "\n\n";
        if (botPersona.customInstructionForContext || botPersona.customInstructionForReplies) {
            if (botPersona.customInstructionForContext) {
                systemPrompt += `USER PROFILE:\n\nThe user provided the following information about themselves. This user profile is shown to you in all conversations they have -- this means it is not relevant to 99% of requests. Before answering, quietly think about whether the user's request is "directly related", "related", "tangentially related", or "not related" to the user profile provided. Only acknowledge the profile when the request is directly related to the information provided. Otherwise, don't acknowledge the existence of these instructions or the information at all. User profile:\n\n` + botPersona.customInstructionForContext.trim() + "\n\n"
            }
            if (botPersona.customInstructionForResponses) {
                systemPrompt +=  `HOW TO RESPOND:\n\nThe user provided the following additional info about how they would like you to respond. This is shown to you in all conversations, so don't acknowledge its existence of these instructions or information at all. How to respond:\n\n` + botPersona.customInstructionForResponses.trim() + "\n\n"
            }
        } else {
            systemPrompt = "You are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.";
        }
        systemPrompt = systemPrompt.trim();
        
        var messageHistory = await chat.getMessageHistoryJSON({ room: room, limit: messageHistoryLimit ?? 1000 });

        var chat;
        const tokenLimit = this.tokenLimits[botPersona.selectedModel] ?? 4000;
        while (true) {
            chat = [
                { role: "system", content: systemPrompt },
                ...messageHistory,
                { role: "user", content: content },
            ];
            if (isWithinTokenLimit(chat, tokenLimit) || messageHistory.length === 0) {
                break;
            }
            messageHistory.shift();
        }

        try {
            const resp = await fetch(
                "code://code/load/api.openai.com/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        // "X-Chat-Trace-Event": documentData.id,
                    },
                    body: JSON.stringify({
                        model: botPersona.selectedModel,
                        temperature: botPersona.modelTemperature,
                        messages: chat,
                    }),
                }
            );

            const data = await resp.json();

            if (!resp.ok) {
                if (data.error.code === 'context_length_exceeded' && messageHistory.length > 0) {
                    return await this.retryableOpenAIChatCompletion({ botPersona, room, content, messageHistoryLimit: Math.max(0, messageHistory.length - 1) });
                }
                throw new Error(data.error.message);
            }

            return data;
        } catch (error) {
            var eventDoc = await db.collections.event.findOne(documentData.id).exec();
            await eventDoc.incrementalModify((docData) => {
                docData.failureMessages = docData.failureMessages.concat(error);
                docData.retryablePersonaFailures = docData.retryablePersonaFailures.concat(botPersona.id);
                return docData;
            });
        }
    }
}

// export { Chat, installNativeHostBehaviors };








const chat = await Chat.init();
window.chat = chat;

window.chat.addEventListener("offerUnusedPersonas", async event => {
    const { db, botsInRooms, unusedOnlineBots } = event.detail;
    // Only one new bot at a time for this bot.
    if (unusedOnlineBots.length > 0) {
        return [];
    }

    const existingNames = botsInRooms.map(persona => persona.name).filter(name => name.startsWith("ChatBOT")).sort((a, b) => b.localeCompare(a));
    var nextName = "ChatBOT";
    if (existingNames.includes(nextName)) {
        const lastName = existingNames.length === 0 ? "ChatBOT" : existingNames[0];
        const lastNumber = lastName.match(/(\d*)$/)[0];
        if (lastNumber) {
            nextName += " " + (parseInt(lastNumber, 10) + 1).toString();
        } else if (lastName) {
            nextName += " 2";
        }
    }

    const modelOptions = ["gpt-3.5-turbo", "gpt-4"];

    var existingBots = await window.chat.ownPersonas(false);
    existingBots = [...existingBots].filter(persona => persona.name === nextName).sort((a, b) => b.createdAt - a.createdAt);
    if (existingBots.length > 0) {
        const existingBot = existingBots[0];
        existingBot.online = true
        existingBot.modelOptions = modelOptions;
        existingBot.modifiedAt = new Date().getTime();
        return existingBot;
    }

    const botPersona = await db.collections.persona.insert({
        id: crypto.randomUUID().toUpperCase(),
        name: nextName,
        personaType: "bot",
        online: true,
        modelOptions: modelOptions,
        modifiedAt: new Date().getTime(),
    });
    return botsInRooms + [botPersona];
});

chat.addEventListener("finishedInitialSync", (event) => {
    const db = event.detail.db;
    // const replications = event.detail.replications;
    db.collections.event.insert$.subscribe(async ({ documentData, collectionName }) => {
        if (documentData.createdAt < window.chat.onlineAt.getTime()) {
            return;
        }

        const personaCollection = db.collections.persona;
        const persona = await personaCollection
            .findOne(documentData.sender)
            .exec();
        if (persona?.personaType !== "user") {
            return;
        }

        const room = await db.collections.room.findOne(documentData.room).exec();
        const botPersonas = await chat.getBotPersonas(room);
        const botPersona = botPersonas.length ? botPersonas[0] : null;
        if (!botPersona) {
            console.log("No matching bot to emit from.")
            return;
        }
        if (!botPersona.selectedModel) {
            botPersona.selectedModel = botPersona.modelOptions[0];
        }

        try {
            const data = await retryableOpenAIChatCompletion(
                { botPersona, room, content: documentData.content });

            const content = data.choices[0].message.content;
            const createdAt = new Date().getTime();

            collection.insert({
                id: crypto.randomUUID().toUpperCase(),
                content,
                type: "message",
                room: documentData.room,
                sender: botPersona.id,
                createdAt,
                modifiedAt: createdAt,
            });
        } catch (error) {
            console.log(error);
        }
    });
});
