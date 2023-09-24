// This will be cleaned up for easier reuse soon. --ChatOnMac

import { consoleProxy } from "jsdelivr.gh:ChatOnMac/chat-js@main/chat/modules/console-proxy.js";

import { createRxDatabase, lastOfArray, deepEqual } from "skypack:rxdb";
import { RxDBDevModePlugin } from "skypack:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "skypack:rxdb/plugins/replication";
import { getRxStorageMemory } from "skypack:rxdb/plugins/storage-memory";
import { deferredPromise } from "skypack:@open-draft/deferred-promise";
import { until } from "skypack:@open-draft/until";
import { strictEventEmitter } from "strict-event-emitter";
import { logger } from "skypack:@open-draft/logger";
import { invariant } from "outvariant";
import { isNodeProcess } from "is-node-process";
import { BatchInterceptor } from 'jsdelivr:@mswjs/interceptors@0.25.4';
import browserInterceptors from 'jsdelivr:@mswjs/interceptors@0.25.4/lib/browser/presets/browser.mjs';

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
        this.db = db;
        this.parentBridge = new ChatParentBridge({ db, state: this.state });
    }

    static async init({ offerUnusedPersonas }) {
        consoleProxy();

        const db = await createRxDatabase({
            name: "chat",
            storage: getRxStorageMemory(),
            eventReduce: true,
            multiInstance: false, // Change this when ported to web etc.
        });

        await this.keepOwnPersonasOnline();
        this.offerUnusedPersonas = offerUnusedPersonas.bind(this) || this.offerUnusedPersonas;
        await this.offerUnusedPersonas();
        await this.wireUnusedPersonas();

        // Invoke the private constructor...
        return new Chat({ db });
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

export { Chat, installNativeHostBehaviors };

