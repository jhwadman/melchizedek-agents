import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../lib/loadEnv.ts';

loadEnv(import.meta.url);

async function purgeSupabase() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
        process.exit(1);
    }

    // Destructive: wipes ALL sessions and memory facts. Require explicit
    // confirmation so this can't be triggered accidentally.
    const confirmed = process.argv.includes('--yes') || process.env.CONFIRM_PURGE === 'true';
    if (!confirmed) {
        console.error("Refusing to purge without confirmation. Re-run with --yes (or CONFIRM_PURGE=true) to wipe all sessions and memory facts.");
        process.exit(1);
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    console.log("Purging all memory facts...");
    const { error: memoryError } = await supabase
        .from('adk_memory_facts')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete everything
    
    if (memoryError) {
        console.error("Failed to purge adk_memory_facts:", memoryError.message);
    } else {
        console.log("Deleted all memory facts.");
    }

    console.log("Purging all sessions...");
    const { error: sessionsError } = await supabase
        .from('adk_sessions')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete everything
        
    if (sessionsError) {
        console.error("Failed to purge adk_sessions:", sessionsError.message);
    } else {
        console.log("Deleted all sessions.");
    }

    console.log("Purge complete!");
    process.exit(0);
}

purgeSupabase().catch(console.error);
