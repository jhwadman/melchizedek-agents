import { 
    BaseSessionService, 
    createSession 
} from '@google/adk';
import type { 
    CreateSessionRequest, 
    GetSessionRequest, 
    ListSessionsRequest, 
    ListSessionsResponse, 
    DeleteSessionRequest, 
    Session, 
    Event 
} from '@google/adk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { trimEventForStorage } from './transcript.ts';

export class SupabaseSessionService extends BaseSessionService {
    private supabase: SupabaseClient;

    constructor(supabaseClient: SupabaseClient) {
        super();
        this.supabase = supabaseClient;
    }

    private getDbId(request: { appName: string, userId: string, sessionId: string }): string {
        return `${request.appName}:${request.userId}:${request.sessionId}`;
    }

    async createSession(request: CreateSessionRequest): Promise<Session> {
        const sessionId = request.sessionId || randomUUID();
        const dbId = this.getDbId({ appName: request.appName, userId: request.userId, sessionId });

        const session = createSession({
            id: sessionId,
            appName: request.appName,
            userId: request.userId,
            state: request.state || {},
            events: [],
            lastUpdateTime: Date.now()
        });

        const cleanSession = JSON.parse(JSON.stringify(session));
        const expireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        const { error } = await this.supabase
            .from('adk_sessions')
            .upsert({
                id: dbId,
                app_name: cleanSession.appName,
                user_id: cleanSession.userId,
                state: cleanSession.state,
                events: cleanSession.events,
                last_update_time: cleanSession.lastUpdateTime,
                expire_at: expireAt
            });

        if (error) {
            console.error('Error creating session in Supabase:', error);
            throw new Error(`Failed to create session: ${error.message}`);
        }

        return session;
    }

    async getSession(request: GetSessionRequest): Promise<Session | undefined> {
        const dbId = this.getDbId(request);
        const { data, error } = await this.supabase
            .from('adk_sessions')
            .select('*')
            .eq('id', dbId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return undefined; // Not found
            }
            console.error('Error getting session from Supabase:', error);
            throw new Error(`Failed to get session: ${error.message}`);
        }

        if (!data) return undefined;

        const session: Session = {
            id: request.sessionId,
            appName: data.app_name,
            userId: data.user_id,
            state: data.state || {},
            events: data.events || [],
            lastUpdateTime: data.last_update_time
        };
        
        // Handle GetSessionConfig (numRecentEvents, afterTimestamp) filters
        if (request.config) {
            if (request.config.afterTimestamp) {
                session.events = session.events.filter((e: Event) => e.timestamp && e.timestamp > request.config!.afterTimestamp!);
            }
            if (request.config.numRecentEvents) {
                session.events = session.events.slice(-request.config.numRecentEvents);
            }
        }
        
        return session;
    }

    async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
        const { data, error } = await this.supabase
            .from('adk_sessions')
            .select('id, app_name, user_id, state, last_update_time')
            .eq('app_name', request.appName)
            .eq('user_id', request.userId);
            
        if (error) {
            console.error('Error listing sessions from Supabase:', error);
            throw new Error(`Failed to list sessions: ${error.message}`);
        }

        const sessions: Session[] = (data || []).map(row => {
            // Extract the original sessionId from the composite key if possible
            const parts = row.id.split(':');
            const originalSessionId = parts.length >= 3 ? parts.slice(2).join(':') : row.id;
            return {
                id: originalSessionId,
                appName: row.app_name,
                userId: row.user_id,
                state: row.state || {},
                events: [], // ListSessions usually returns omitted events to save bandwidth
                lastUpdateTime: row.last_update_time
            };
        });
        
        return { sessions };
    }

    async deleteSession(request: DeleteSessionRequest): Promise<void> {
        const dbId = this.getDbId(request);
        const { error } = await this.supabase
            .from('adk_sessions')
            .delete()
            .eq('id', dbId);
            
        if (error) {
            console.error('Error deleting session from Supabase:', error);
            throw new Error(`Failed to delete session: ${error.message}`);
        }
    }
    
    async appendEvent(request: { session: Session, event: Event }): Promise<Event> {
        const { session, event } = request;
        const dbId = this.getDbId({ appName: session.appName, userId: session.userId, sessionId: session.id });

        // Partial events are streaming fragments of an event that is appended
        // whole when it completes. The runner already guards this, but the
        // base contract does too, and a service that persists them would write
        // every token twice.
        if (event.partial) return event;

        // Standard ADK internal state merging. This MUST go through the base
        // implementation: it applies `event.actions.stateDelta` to
        // `session.state` and strips `temp:` keys before pushing the event.
        // Re-implementing it as a bare `events.push` (as this did until
        // 2026-08-15) silently drops every state write — `output_key`, any
        // state-injected instruction variable — and leaves `session.state`
        // permanently `{}`, which is exactly what every stored row showed.
        await super.appendEvent({ session, event });
        session.lastUpdateTime = Date.now();

        // Trim on the SERIALIZED COPY only. The live session keeps thought
        // signatures and real tool payloads — the agent's own tool loop reads
        // them back mid-turn — but nothing reads them from the ROW: the
        // projection drops both on the way into a prompt, and the memory
        // service walks `part.text` alone. Across 128 live sessions they were
        // ~90% of every byte stored (73% of it Gemini's `thoughtSignature`),
        // and this method re-uploads the whole array on every event, so those
        // bytes were paid for again on each one. See trimEventForStorage.
        const cleanSession = JSON.parse(JSON.stringify(session));
        cleanSession.events = (cleanSession.events as Event[]).map((e: Event) => trimEventForStorage(e));
        const expireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        const { error } = await this.supabase
            .from('adk_sessions')
            .upsert({
                id: dbId,
                app_name: cleanSession.appName,
                user_id: cleanSession.userId,
                state: cleanSession.state,
                events: cleanSession.events,
                last_update_time: cleanSession.lastUpdateTime,
                expire_at: expireAt
            });
            
        if (error) {
            console.error('Error appending event to session in Supabase:', error);
            throw new Error(`Failed to append event: ${error.message}`);
        }
        
        return event;
    }
}
