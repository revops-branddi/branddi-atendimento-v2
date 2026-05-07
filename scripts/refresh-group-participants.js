/**
 * One-shot: re-popula group_participants em grupos já marcados (is_group=true)
 * com a nova shape que inclui o campo `id` (attendee_id) — necessário pra
 * resolver senderName via match com msg.sender_attendee_id.
 *
 * Uso:
 *   node scripts/refresh-group-participants.js [--dry-run]
 *
 * Idempotente: rodar de novo só atualiza com a versão mais fresca de attendees.
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;
const BASE = DSN ? `https://${DSN}/api/v1` : null;
const DRY_RUN = process.argv.includes('--dry-run');

async function unipileGet(endpoint) {
    const res = await fetch(`${BASE}${endpoint}`, {
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Unipile ${res.status}: ${endpoint}`);
    return res.json();
}

function normalizeParticipants(attendees) {
    return (attendees || []).map(a => ({
        id:          a.id || null,
        provider_id: a.provider_id || null,
        name:        a.name || null,
        phone:       a.specifics?.phone_number || a.phone_number || null,
        is_self:     !!a.is_self,
    }));
}

async function main() {
    if (!API_KEY || !DSN) { console.error('Unipile não configurado'); process.exit(1); }

    const { data: groups, error } = await supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, group_subject, group_participants')
        .eq('is_group', true)
        .not('whatsapp_chat_id', 'is', null);
    if (error) { console.error('Erro:', error.message); process.exit(1); }

    console.log(`${groups.length} grupos pra processar (dry-run=${DRY_RUN})`);
    let updated = 0, errored = 0;

    for (const g of groups) {
        try {
            const att = await unipileGet(`/chats/${g.whatsapp_chat_id}/attendees`);
            const participants = normalizeParticipants(att.items || []);

            const oldHasId = (g.group_participants || []).some(p => p.id);
            const newCount = participants.filter(p => p.id).length;
            console.log(`  ${g.id} ${g.group_subject || '(sem nome)'}: ${participants.length} membros (${newCount} com id) — antes ${oldHasId ? 'TINHA' : 'NÃO TINHA'} id`);

            if (!DRY_RUN) {
                await supabase
                    .from('conversations')
                    .update({ group_participants: participants })
                    .eq('id', g.id);
                updated++;
            }
        } catch (err) {
            errored++;
            console.error(`  ✗ ${g.id}: ${err.message}`);
        }
    }

    console.log(`\nResumo: ${updated} atualizados, ${errored} erros, ${groups.length - updated - errored} pulados (dry-run)`);
}

main().catch(err => { console.error('Falha:', err); process.exit(1); });
