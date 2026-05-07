/**
 * One-shot: enriquece group_participants[].name pra membros que vieram
 * sem nome do Unipile (campo `name` null/empty).
 *
 * Cascata:
 *   1. pushName extraído de raw.original.pushName das mensagens do
 *      próprio grupo (cobertura alta — todo membro que mandou msg)
 *   2. Pipedrive findPersonByPhone (cobertura baixa — só quem está
 *      cadastrado no CRM)
 *   3. Permanece null → frontend mostra phone formatado em vez de
 *      "Sem nome"
 *
 * Uso:
 *   node scripts/enrich-group-member-names.js [--dry-run]
 *
 * Idempotente.
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';
import { findPersonByPhone } from '../src/services/pipedrive.js';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;
const BASE = DSN ? `https://${DSN}/api/v1` : null;
const DRY = process.argv.includes('--dry-run');

async function unipileGet(endpoint) {
    const res = await fetch(`${BASE}${endpoint}`, {
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Unipile ${res.status}: ${endpoint}`);
    return res.json();
}

// Extrai mapa sender_attendee_id → pushName das mensagens recentes
async function extractPushNamesFromGroup(chatId, limit = 200) {
    const msgs = await unipileGet(`/chats/${chatId}/messages?limit=${limit}`);
    const map = new Map();
    for (const m of (msgs.items || [])) {
        if (!m.sender_attendee_id || map.has(m.sender_attendee_id)) continue;
        try {
            const o = typeof m.original === 'string' ? JSON.parse(m.original) : m.original;
            if (o?.pushName && o.pushName.trim()) {
                map.set(m.sender_attendee_id, o.pushName.trim());
            }
        } catch { /* ignora msgs com original mal-formado */ }
    }
    return map;
}

async function main() {
    if (!API_KEY || !DSN) { console.error('Unipile não configurado'); process.exit(1); }

    const { data: groups, error } = await supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, group_subject, group_participants')
        .eq('is_group', true)
        .not('whatsapp_chat_id', 'is', null);
    if (error) { console.error('Erro:', error.message); process.exit(1); }

    let totalNoName = 0;
    let resolvedByPushName = 0;
    let resolvedByPipedrive = 0;
    let stillUnresolved = 0;
    let groupsUpdated = 0;

    for (const g of groups) {
        const noNameMembers = (g.group_participants || []).filter(p => !p.name && p.id);
        if (noNameMembers.length === 0) continue;

        totalNoName += noNameMembers.length;
        console.log(`\n${g.group_subject || '(sem nome)'}: ${noNameMembers.length} sem nome`);

        // (1) pushName das mensagens do grupo
        let pushNameMap;
        try {
            pushNameMap = await extractPushNamesFromGroup(g.whatsapp_chat_id);
        } catch (err) {
            console.log(`  ⚠️  Erro buscando msgs: ${err.message} (pulando pushName)`);
            pushNameMap = new Map();
        }

        const updates = new Map(); // attendee_id → newName
        for (const m of noNameMembers) {
            const fromPush = pushNameMap.get(m.id);
            if (fromPush) {
                updates.set(m.id, { name: fromPush, source: 'pushName' });
                resolvedByPushName++;
                continue;
            }
            // (2) Pipedrive por phone — fallback caro, só pros que sobraram
            if (m.phone) {
                try {
                    const person = await findPersonByPhone(m.phone);
                    if (person?.name) {
                        updates.set(m.id, { name: person.name, source: 'pipedrive' });
                        resolvedByPipedrive++;
                        continue;
                    }
                } catch { /* segue */ }
                await new Promise(r => setTimeout(r, 200)); // rate-limit cuidadoso
            }
            stillUnresolved++;
        }

        if (updates.size === 0) {
            console.log(`  → 0 resolvidos`);
            continue;
        }

        // Aplica updates ao array — preserva ordem e demais campos
        const newParticipants = (g.group_participants || []).map(p => {
            const upd = updates.get(p.id);
            return upd ? { ...p, name: upd.name } : p;
        });

        const summary = Array.from(updates.entries())
            .map(([id, u]) => `${u.name} (${u.source})`)
            .join(', ');
        console.log(`  → ${updates.size} resolvidos: ${summary}`);

        if (!DRY) {
            const { error: updErr } = await supabase
                .from('conversations')
                .update({ group_participants: newParticipants })
                .eq('id', g.id);
            if (updErr) console.error(`  ✗ erro update: ${updErr.message}`);
            else groupsUpdated++;
        }
    }

    console.log('\n=== Resumo ===');
    console.log(`Total sem nome no início: ${totalNoName}`);
    console.log(`Resolvidos via pushName:  ${resolvedByPushName}`);
    console.log(`Resolvidos via Pipedrive: ${resolvedByPipedrive}`);
    console.log(`Ainda sem nome:           ${stillUnresolved}`);
    console.log(`Grupos atualizados:       ${DRY ? '(dry-run)' : groupsUpdated}`);
}

main().catch(err => { console.error('Falha:', err); process.exit(1); });
