/**
 * One-shot: limpa conversas que são GRUPOS WhatsApp do schema site.*.
 *
 * Antes do fix em src/site/services/ingest.js (que pula isGroupChat no
 * polling), o ingest do /site importava todos os chats da conta WhatsApp
 * dedicada — incluindo grupos onde o número foi adicionado. Isso poluía
 * a fila de atendimento humano com grupos que não são DMs do site.
 *
 * Estratégia:
 *   1. Lista todas as conversations no schema site.*
 *   2. Pra cada uma, consulta o chat correspondente no Unipile
 *   3. Se for grupo (chat.type === 1 ou provider_id em @g.us), arquiva
 *      a conversa (status='resolved' + flag em metadata).
 *
 * Uso:
 *   node scripts/cleanup-site-groups.js [--dry-run] [--limit=N]
 *
 * Idempotente: rodar de novo não faz nada porque já vão estar resolved.
 *
 * Por que `resolved` em vez de delete?
 *   - Preserva histórico (mensagens já indexadas continuam pesquisáveis)
 *   - UI já filtra resolved da fila padrão
 *   - Reversível se algum grupo for marcado por engano
 */
import 'dotenv/config';
import siteDb from '../src/site/services/db.js';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { dryRun: false, limit: null };
    for (const a of args) {
        if (a === '--dry-run')        opts.dryRun = true;
        else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice(8), 10);
    }
    return opts;
}

async function unipileGet(endpoint) {
    const res = await fetch(`${BASE}${endpoint}`, {
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Unipile ${res.status}: ${endpoint}`);
    return res.json();
}

function isGroupChat(chat) {
    return chat?.type === 1 || String(chat?.provider_id || '').endsWith('@g.us');
}

async function main() {
    if (!API_KEY || !DSN) {
        console.error('UNIPILE_API_KEY e UNIPILE_DSN são obrigatórios.');
        process.exit(1);
    }

    const opts = parseArgs();
    console.log(`Cleanup site groups — ${opts.dryRun ? 'DRY-RUN' : 'AO VIVO'}${opts.limit ? ` (limit=${opts.limit})` : ''}`);

    let q = siteDb.from('conversations')
        .select('id, whatsapp_chat_id, status, lead_id, leads(name, phone)')
        .neq('status', 'resolved')
        .order('created_at', { ascending: true });
    if (opts.limit) q = q.limit(opts.limit);

    const { data: convs, error } = await q;
    if (error) {
        console.error('Erro ao listar conversations:', error.message);
        process.exit(1);
    }

    console.log(`${convs.length} conversation(s) ativa(s) pra checar.`);

    let groupCount = 0;
    let dmCount    = 0;
    let errCount   = 0;
    const groupIds = [];

    for (const conv of convs) {
        try {
            const chat = await unipileGet(`/chats/${conv.whatsapp_chat_id}`);
            if (isGroupChat(chat)) {
                groupCount++;
                groupIds.push(conv.id);
                console.log(`  GROUP ${conv.id} chat=${conv.whatsapp_chat_id} lead=${conv.leads?.name || '?'} type=${chat.type} provider_id=${chat.provider_id || '?'}`);
            } else {
                dmCount++;
            }
        } catch (err) {
            errCount++;
            console.warn(`  ERROR ${conv.id} chat=${conv.whatsapp_chat_id}: ${err.message}`);
        }
    }

    console.log(`\nResumo: ${groupCount} grupos, ${dmCount} DMs, ${errCount} erros`);

    if (opts.dryRun) {
        console.log('Dry-run: nenhuma alteração feita.');
        return;
    }

    if (!groupIds.length) {
        console.log('Nada pra arquivar.');
        return;
    }

    const { error: updErr } = await siteDb
        .from('conversations')
        .update({
            status:     'resolved',
            updated_at: new Date().toISOString(),
        })
        .in('id', groupIds);

    if (updErr) {
        console.error('Erro ao arquivar:', updErr.message);
        process.exit(1);
    }

    console.log(`✔ ${groupIds.length} grupos arquivados (status=resolved).`);
}

main().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
