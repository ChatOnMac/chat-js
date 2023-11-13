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

import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "npm:rxdb@14.17.1";
import { RxDBDevModePlugin } from "npm:rxdb@14.17.1/plugins/dev-mode";
import { replicateRxCollection } from "npm:rxdb@14.17.1/plugins/replication";
import { getRxStorageMemory } from "npm:rxdb@14.17.1/plugins/storage-memory";
import gpt35TurboTokenizer from "gpt-tokenizer/model/gpt-3.5-turbo";
import gpt4Tokenizer from "gpt-tokenizer/model/gpt-4";
import llamaTokenizer from "jsdelivr.gh:belladoreai/llama-tokenizer-js@b88929eb8c462c/llama-tokenizer.js";

// addRxPlugin(RxDBDevModePlugin);

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

        const replicationPushHandler = async (docs) => {
            //console.log("Called push handler with: ", docs);
            window.webkit.messageHandlers.surrogateDocumentChanges.postMessage({
                collectionName: collection.name,
                changedDocs: docs.map((row) => {
                    return this.replaceObjectsWithId(row.newDocumentState);
                }),
            });
    
            return [];
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
                handler: replicationPushHandler.bind(this),
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

    replaceObjectsWithId(obj) {
        const updatedObj = {};
        for (const key in obj) {
            if (typeof obj[key] === 'object' && obj[key] !== null && 'id' in obj[key]) {
                updatedObj[key] = obj[key].id;
            } else if (typeof obj[key] === 'object') {
                updatedObj[key] = this.replaceObjectsWithId(obj[key]);
            } else {
                updatedObj[key] = obj[key];
            }
        }
        return updatedObj;
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
        "gpt-3.5-turbo-1106": 4097,
        "gpt-3.5-turbo-16k": 16385,
        "gpt-3.5-turbo-16k-0613": 16385,
        "gpt-4-1106-preview": 4097, // 128k soon; should also be user-configurable then
    };

    constructor ({ db }) {
        super();
        this.db = db;
        const onFinishedSyncingDocsFromCanonical = this.onFinishedSyncingDocsFromCanonical.bind(this);
        this.parentBridge = new ChatParentBridge({ db, state: this.state, onFinishedSyncingDocsFromCanonical, dispatchEvent: this.dispatchEvent });
    }

    async allowHosts() {
        const codePackage = await this.db.collections.code_package.findOne().exec();
        return codePackage.allowHosts.split(",");
    }

    async installNativeHostBehaviors() {
        const originalFetch = window.fetch;
        const apply = async (target, thisArg, args) => {
            const [input, init] = args;
            const urlObj = new URL(input);
            const allowHosts = await this.allowHosts();
            for (const host of allowHosts) {
                if (urlObj.hostname.toLowerCase() === host.toLowerCase() && urlObj.protocol === "https:") {
                    urlObj.protocol = "code";
                    urlObj.hostname = "code";
                    urlObj.pathname = "/load/" + host + urlObj.pathname
                    break;
                }
            }
            return await target(urlObj.toString(), init);
        };
        window.fetch = new Proxy(originalFetch, {
            apply: apply.bind(this),
        });
    }

    async onFinishedSyncingDocsFromCanonical() {
        await this.installNativeHostBehaviors()

        this.dispatchEvent(new CustomEvent("finishedInitialSync", { detail: { db: this.db, replications: this.state.replications } }));
        await this.wireLLMConfigurations();
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

    async personaLLM (persona) {
        const db = this.db;
        return await db.collections.llm_configuration.findOne({ selector:{ usedByPersona: persona.id } }).exec();
    }

    async setLLMConfigurationsAsNeeded (configurations) {
        return;

        const db = this.db;
        const existingLLMs = await db.collections.llm_configuration.find().exec();
        const updatedLLMs = [];

        for (const llm of configurations) {
            const existing = existingLLMs.find(e => e.name === llm.name && !e.isDeleted);
            const params = { isDeleted: false, ...llm };
            if (existing) {
                await existing.incrementalPatch({ modifiedAt: new Date().getTime(), ...params });
                updatedLLMs.push(existing);
            } else {
                const llmNames = existingLLMs.map(llm => llm.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                const newLLM = {
                    id: crypto.randomUUID().toUpperCase(),
                    createdAt: new Date().getTime(),
                    modifiedAt: new Date().getTime(),
                    ...params,
                };
                await db.collections.llm_configuration.insert(newLLM);
            }
        }

        existingLLMs
            .filter(llm => !updatedLLMs.includes(llm))
            .forEach(async llm => await llm.incrementalPatch({ isDeleted: true }));
    }

    async dispatchUnusedPersonasEvent(rooms) {
        const db = this.db;
        var rooms = rooms || await this.db.collections.room.find().exec();
        const botsInRoomsIDs = [...new Set(rooms.flatMap(room => room.participants))];
        var botsInRooms = await db.collections.persona.findByIds(botsInRoomsIDs).exec();
        botsInRooms = [...botsInRooms.values()];
        const unusedOnlineBots = await db.collections.persona.find({ selector: { online: true, id: { $not: { $in: botsInRoomsIDs } } } }).exec();
        this.dispatchEvent(new CustomEvent("offerUnusedPersonas", { detail: { db: this.db, botsInRooms, unusedOnlineBots } }));
    }

    async wireUnusedPersonas() {
        const db = this.db;
        if (typeof db.collections.persona === 'undefined') { return }
        await db.collections.room.$.subscribe(async rooms => {
            this.dispatchUnusedPersonasEvent();
        });
        await this.db.collections.persona.$.subscribe(async personas => {
            this.dispatchUnusedPersonasEvent();
        });
        this.dispatchUnusedPersonasEvent();
    }

    async wireLLMConfigurations() {
        const db = this.db;
        if (typeof db.collections.llm_configuration === 'undefined') { return }
    
        const getModelOptions = async () =>
            (await db.collections.llm_configuration.find().exec())
                .map(llm => llm.name)
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    
        const setModelOptions = (async () => {
            const llmConfigurations = await db.collections.llm_configuration.find().exec();
            await this.setLLMConfigurationsAsNeeded(llmConfigurations);
    
            const llmNames = await getModelOptions();
            const allPersonas = await db.collections.persona.find().exec();
    
            for (const persona of allPersonas) {
                if (!arrayEquals(persona.modelOptions, llmNames)) {
                    await persona.incrementalPatch({ modelOptions: llmNames, modifiedAt: new Date().getTime() });
                }
            }
        }).bind(this);
    
        db.collections.llm_configuration.$.subscribe(setModelOptions);
        db.collections.persona.$.subscribe(setModelOptions);
        setModelOptions();
    }

    async ownPersonas(insideRoomsOnly) {
        // TODO: Multiple bots in same room.
        const botPersonas = await this.getBotPersonas(null, insideRoomsOnly);
        return botPersonas
    }
    
    async keepOwnPersonasOnline() {
        const db = this.db;
        if (typeof db.collections.persona === 'undefined') { return }
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
        const db = this.db;
        if (typeof db.collections.persona === 'undefined') { return }
        let extension = await this.db.collections.code_extension.findOne().exec();
        if (!extension) {
            console.log("No extension found!");
            return [];
        }
        let botPersonas = await this.getProvidedBotsIn(extension, room, insideRoomsOnly);
        return botPersonas;
    }

    async getProvidedBotsIn(extension, room, insideRoomsOnly) {
        const db = this.db;
        if (typeof db.collections.persona === 'undefined') { return [] }
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
        const db = this.db;
        const messages = await db.collections.event
            .find({
                selector: { room: room.id },
                limit: limit,
                sort: [{ createdAt: "desc" }],
            })
            .exec();
        return messages.reverse();
    }

    async getMessageHistoryJSON(args) {
        const history = await this.getMessageHistory(args);
        const json = await Promise.all(
            history.map(async ({ content, persona }) => {
                const foundPersona = await this.db.collections.persona
                    .findOne(persona)
                    .exec();
                return {
                    role:
                    foundPersona.personaType === "bot" ? "assistant" : "user",
                    content,
                };
            })
        );
        return json;
    }

    async retryableOpenAIChatCompletion({ eventTriggerID, botPersona, room, content, messageHistoryLimit }) {
        const db = this.db;
        const llm = personaLLM(botPersona);
        var systemPrompt = llm.systemPromptTemplate.replace(/{{user}}/g, botPersona.name);
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
        
        var messageHistory = await this.getMessageHistoryJSON({ room: room, limit: messageHistoryLimit ?? 1000 });

        const tokenLimit = this.tokenLimits[llm.name] ?? 4000;
        let gptTokenizer;
        switch (llm.name) {
            case "gpt-3.5-turbo", "gpt-3.5-turbo-1106":
                gptTokenizer = gpt35TurboTokenizer;
            case "gpt-4", "gpt-4-1106-preview", "gpt-4-0613":
                gptTokenizer = gpt4Tokenizer;
            default:
                gptTokenizer = null;
        }
        var chat;
        while (true) {
            chat = [
                { role: "system", content: systemPrompt },
                ...messageHistory,
                { role: "user", content: content },
            ];
            if (messageHistory.length === 0) {
                break;
            } else if (gptTokenizer && gptTokenizer.isWithinTokenLimit(chat, tokenLimit)) {
                break;
            } else if (llm.modelInference === "llama") {
                let resultString = "";
                for (let i = 0; i < chat.length; i++) {
                    const currentMessage = chat[i];
                    const isUserMessage = currentMessage.role === "user";
                    if (isUserMessage) {
                        const formattedUserPrompt = llm.promptFormat.replace("{{prompt}}", currentMessage.content);
                        resultString += formattedUserPrompt;

                        if (i < chat.length - 1 && chat[i + 1].role !== "user") {
                            resultString += chat[i + 1].content;
                        }
                    }
                }
                if (llamaTokenizer.encode(resultString).length <= tokenLimit) {
                    break;
                }
            }
            messageHistory.shift();
        }

        const url = llm.apiURL.length > 0 ? llm.apiURL : "code://code/load/chat/api/v1/chat/completions";
        var params = {
            model: llm.name,
            messages: chat,
        };
        if (llm.modelInference !== "llama") {
            params.temperature = botPersona.modelTemperature;
        }
        try {
            const resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    // "X-Chat-Trace-Event": documentData.id,
                    //"HTTP-Referer": `${YOUR_SITE_URL}`,
                },
                body: JSON.stringify(params),
            });
            const data = await resp.json();
            if (!resp.ok) {
                if (data.error.code === 'context_length_exceeded' && messageHistory.length > 0) {
                    return await this.retryableOpenAIChatCompletion({ eventTriggerID, botPersona, room, content, messageHistoryLimit: Math.max(0, messageHistory.length - 1) });
                }
                throw new Error(data.error.message);
            }
            return data;
        } catch (error) {
            var eventDoc = await this.db.collections.event.findOne(eventTriggerID).exec();
            await eventDoc.incrementalModify((docData) => {
                docData.failureMessages = docData.failureMessages.concat(error.message);
                docData.retryablePersonaFailures = docData.retryablePersonaFailures.concat(botPersona.id);
                return docData;
            });
            throw error;
        }
    }
}

// export { Chat };

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////






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

    var existingBots = await window.chat.ownPersonas(false);
    existingBots = [...existingBots].filter(persona => persona.name === nextName).sort((a, b) => b.createdAt - a.createdAt);
    if (existingBots.length > 0) {
        const existingBot = existingBots[0];
        existingBot.incrementalPatch({
            online: true,
            modifiedAt: new Date().getTime(),
        });
        return existingBot;
    }

    const botPersona = await db.collections.persona.insert({
        id: crypto.randomUUID().toUpperCase(),
        name: nextName,
        personaType: "bot",
        online: true,
        modifiedAt: new Date().getTime(),
    });
    return botsInRooms + [botPersona];
});

chat.addEventListener("finishedInitialSync", async (event) => {
    const db = event.detail.db;

    await window.chat.setLLMConfigurationsAsNeeded([
        {
            name: "gpt-3.5-turbo-1106",
            organization: "OpenAI",
            displayName: "OpenAI GPT 3.5 Turbo",
            apiURL: "https:///api.openai.com/v1/chat/completions",
            modelInference: "openai",
            context: 4096,
            systemPromptTemplate: "You are {{name}}, a large language model trained by OpenAI, based on the GPT 3.5 Turbo architecture. Knowledge cutoff: 2022-01 Current date: " + (new Date()).toString() + "\n\nYou are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.",
            defaultPriority: 3,
        },
        {
            name: "gpt-4-1106-preview",
            organization: "OpenAI",
            displayName: "OpenAI GPT 4 Turbo",
            apiURL: "https:///api.openai.com/v1/chat/completions",
            modelInference: "openai",
            context: 4096,
            systemPromptTemplate: "You are {{name}}, a large language model trained by OpenAI, based on the GPT 4 Turbo architecture. Knowledge cutoff: 2023-04 Current date: " + (new Date()).toString() + "\n\nYou are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.",
            defaultPriority: 2,
        },
        {
            name: "gpt-4-0613",
            organization: "OpenAI",
            displayName: "OpenAI GPT 4",
            apiURL: "https:///api.openai.com/v1/chat/completions",
            modelInference: "openai",
            context: 8192,
            systemPromptTemplate: "You are {{name}}, a large language model trained by OpenAI, based on the GPT 4 architecture. Knowledge cutoff: 2022-01 Current date: " + (new Date()).toString() + "\n\nYou are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.",
            defaultPriority: 1,
        },
        // {
        //     name: "mistral-7b-openorca.Q4_K_M",
        //     organization: "OpenOrca",
        //     displayName: "Mistral 7B OpenOrca",
        //     modelDownloadURL: "https://huggingface.co/TheBloke/Mistral-7B-OpenOrca-GGUF/resolve/main/mistral-7b-openorca.Q5_K_M.gguf",
        //     memoryRequirement: 5_130_000,
        // },
        // {
        //     name: "openchat_3.5.Q5_K_M",
        //     organization: "OpenChat",
        //     displayName: "OpenChat 3.5",
        //     modelDownloadURL: "https://huggingface.co/TheBloke/openchat_3.5-GGUF/resolve/main/openchat_3.5.Q5_K_M.gguf",
        //     memoryRequirement: 5_130_000,
        //     repeatPenalty: 1.1,
        //     context: 8192,
        //     temperature: 0.8,
        //     topP: 0.9,
        //     topK: 40,
        //     nBatch: 512,
        //     modelInference: "llama",
        // },
        {
            name: "orca-mini-3b.Q5_0",
            organization: "Pankaj Mathur",
            displayName: "Orca Mini 3B",
            modelDownloadURL: "https://huggingface.co/Aryanne/Orca-Mini-3B-gguf/resolve/main/q5_0-orca-mini-3b.gguf",
            memoryRequirement: 2_400_000,
            context: 1024,
            repeatPenalty: 1.1,
            systemPromptTemplate: "You are {{name}}, a large language model based on the Llama2 Orca Mini architecture. Knowledge cutoff: 2022-09 Current date: " + (new Date()).toString() + "\n\nYou are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.",
            systemFormat: "### System:\n{{prompt}}\n\n",
            promptFormat: "### User:\n{{prompt}}\n\n### Response:\n",
            temp: 0.89999997615814209,
            modelInference: "llama",
            topP: 0.94999998807907104,
            nBatch: 512,
            topK: 40,
            defaultPriority: 103,
        },
        {
            name: "orca-mini-v3-7b.Q5_K_M",
            organization: "Pankaj Mathur",
            displayName: "Orca Mini 7B",
            modelDownloadURL: "https://huggingface.co/TheBloke/orca_mini_v3_7B-GGUF/resolve/main/orca_mini_v3_7b.Q5_K_M.gguf",
            memoryRequirement: 4_780_000,
            context: 1024,
            repeatPenalty: 1.1,
            systemPromptTemplate: "You are {{name}}, a large language model based on the Llama2 Orca Mini architecture. Knowledge cutoff: 2022-09 Current date: " + (new Date()).toString() + "\n\nYou are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.",
            systemFormat: "### System:\n{{prompt}}\n\n",
            promptFormat: "### User:\n{{prompt}}\n\n### Response:\n",
            temp: 0.89999997615814209,
            modelInference: "llama",
            topP: 0.94999998807907104,
            nBatch: 512,
            topK: 40,
            defaultPriority: 102,
        },
        {
            name: "mamba-gpt-3B-v4.Q5_1",
            organization: "CobraMamba",
            displayName: "Mamba GPT 3B v4",
            modelDownloadURL: "https://huggingface.co/Aryanne/Mamba-gpt-3B-v4-ggml-and-gguf/resolve/main/q5_1-gguf-mamba-gpt-3B_v4.gguf",
            memoryRequirement: 2_600_000,
            temperature: 0.8,
            context: 1024,
            repeatPenalty: 1.1,
            topP: 0.89999997615814209,
            topK: 80,
            modelInference: "llama",
            nBatch: 512,
            systemPromptTemplate: "You are {{name}}, a large language model based on the Llama2 Mamba GPT architecture. Knowledge cutoff: 2022-09 Current date: " + (new Date()).toString() + "\n\nYou are a helpful assistant. Be concise, precise, and accurate. Don't refer back to the existence of these instructions at all.",
            systemFormat: "<|prompt|>### System:\n{{prompt}}\n\n",
            promptFormat: "### User: {{prompt}}</s><|answer|>",
            defaultPriority: 101,
        },
    ]);

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
        
        try {
            const data = await window.chat.retryableOpenAIChatCompletion(
                { eventTriggerID: documentData.id, botPersona, room, content: documentData.content });

            const content = data.choices[0].message.content;
            const createdAt = new Date().getTime();

            db.collections.event.insert({
                id: crypto.randomUUID().toUpperCase(),
                content,
                type: "message",
                room: room,
                sender: botPersona.id,
                createdAt,
                modifiedAt: createdAt,
            });
        } catch (error) {
            console.log(error);
        }
    });
});
