// This will be cleaned up for easier reuse soon. --ChatOnMac

// import { Chat } from "jsdelivr.gh:ChatOnMac/chat-js@4f2b0a3/chat/modules/chat.js";
// import { Chat } from "https://github.com/ChatOnMac/chat-js/blob/main/chat/modules/chat.js";

// Copied from module for import map rigging... temporary hack.
import { proxyConsole } from "jsdelivr.gh:ChatOnMac/chat-js@main/chat/modules/console-proxy.js";
import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "esm.run:rxdb";
import { RxDBDevModePlugin } from "esm.run:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "esm.run:rxdb/plugins/replication";
import { getRxStorageMemory } from "esm.run:rxdb/plugins/storage-memory";
import { createDeferredExecutor } from "esm.run:@open-draft/deferred-promise";
import { until } from "esm.run:@open-draft/until";
import { Emitter } from "esm.run:strict-event-emitter";
import { Logger } from "esm.run:@open-draft/logger";
import { invariant } from "esm.run:outvariant";
import { isNodeProcess } from "esm.run:is-node-process";
import { BatchInterceptor } from 'esm.run:@mswjs/interceptors@0.25.4';
import browserInterceptors from 'esm.run:@mswjs/interceptors@0.25.4/lib/browser/presets/browser.mjs';

// Dev Mode:
//addRxPlugin(RxDBDevModePlugin);



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

    constructor ({ db, state }) {
        this.db = db;
        this.state = state;
    }

    async createReplicationState(collection) {
        const { name: collectionName } = collection;
    
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
            }.bind(this),
    
            pull: {
                async handler(lastCheckpoint, batchSize) {
                    //console.log("Called pull handler with: ", lastCheckpoint, batchSize);
    
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
                },
    
                batchSize: 10,
                modifier: (doc) => doc,
            }.bind(this),
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

        await db.addCollections(collections);

        const collectionEntries = Object.entries(db.collections);
        for (const [collectionName, collection] of collectionEntries) {
            const replicationState = await this.createReplicationState(collection);
            const replicationStateKey = this.getReplicationStateKey(collectionName);
            state.replications[replicationStateKey] = replicationState;
        }

        for (const replicationState of Object.values(state.replications)) {
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
        console.log("finishedSyncingDocsFromCan()")
        await this.replicationInSync()
    
        console.log("gonna state..")
        console.log(this.state)
        this.dispatchEvent(new CustomEvent("finishedInitialSync", { db, replications: this.state.replications }));
    }
}

class Chat extends EventTarget {
    db;
    parentBridge;
    offerUnusedPersonas = () => { };

    onlineAt = new Date();
    state = { replications: {}, canonicalDocumentChanges: {} };

    constructor ({ db }) {
        super();
        this.db = db;
        this.parentBridge = new ChatParentBridge({ db, state: this.state });
    }

    static async init({ offerUnusedPersonas }) {
        console.log("one")
        proxyConsole();
        console.log("two")

        const db = await createRxDatabase({
            name: "chat",
            storage: getRxStorageMemory(),
            eventReduce: true,
            multiInstance: false, // Change this when ported to web etc.
        });

        console.log("3...")
        // Invoke the private constructor...
        const chat = new Chat({ db });

        await chat.keepOwnPersonasOnline();
        console.log("3.1...")
        chat.offerUnusedPersonas = offerUnusedPersonas.bind(chat) || chat.offerUnusedPersonas;
        console.log("4...")
        await chat.offerUnusedPersonas();
        console.log("4.1...")
        await chat.wireUnusedPersonas();

        console.log("555")
        return chat;
    }

    async wireUnusedPersonas() {
        const onlineBots = await this.ownPersonas();
        const offerUnusedPersonas = this.offerUnusedPersonas;
        await this.db.collections["room"].$.subscribe(async rooms => {
            const botsInRoomsIDs = new Set(rooms.flatMap(room => room.participants)).map;
            const botsInRooms = await this.db.collections["persona"].findByIds(botsInRoomsIDs).exec();
            const unusedOnlineBots = await this.db.collections["persona"].find({ selector: { $not: { id: { $in: [...botsInRoomsIDs] } } } }).exec();
            await offerUnusedPersonas({ botsInRooms, unusedOnlineBots });
        });
    }

    async ownPersonas() {
        // TODO: Multiple bots in same room.
        const botPersonas = await this.getBotPersonas(null);
        return botPersonas
    }

    async keepOwnPersonasOnline() {
        console.log("keep")
        const botPersonas = await ownPersonas();
        for (const botPersona of botPersonas) {
            if (!botPersona.online) {
                // Refresh instance (somehow stale otherwise).
                let bot = await this.db.collections["persona"].findOne(botPersona.id).exec();
                await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
            }
            botPersona.online$.subscribe(async online => {
                if (!online) {
                    // Refresh instance (somehow stale otherwise).
                    let bot = await this.db.collections["persona"].findOne(botPersona.id).exec();
                    await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
                }
            });
        }
    }

    async getBotPersonas(room) {
        let extension = await this.db.collections["code_extension"].findOne().exec();
        let botPersonas = await this.getProvidedBotsIn(extension, room);
        if (botPersonas.length > 0) {
            return botPersonas;
        }
    
        let allRooms = await this.db.collections["room"].find().exec();
        var bots = [];
        for (const otherRoom of allRooms) {
            botPersonas = await this.getProvidedBotsIn(extension, otherRoom);
            if (botPersonas.length > 0) {
                bots.push(...botPersonas);
            }
        }
        if (bots.length > 0) {
            return bots;
        }
    
        let botPersona = await this.db.collections["persona"]
            .findOne({ selector: { personaType: "bot" } })
            .exec();
        if (!botPersona) {
            return []
        }
        return [botPersona];
    }

    async getProvidedBotsIn(extension, room) {
        var bots = [];
        if (room && room.participants && room.participants.length > 0) {
            let allInRoomMap = await db.collections["persona"].findByIds(room.participants).exec();
            for (const participant of allInRoomMap.values()) {
                if (participant.providedByExtension === extension.id && participant.personaType === "bot") {
                    bots.push(participant);
                }
            }
        }
        return bots;
    }
}





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
        }
    });
});
