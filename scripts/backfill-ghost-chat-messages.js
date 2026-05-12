/**
 * One-shot: marca retroativamente mensagens que ficaram órfãs em ghost chats.
 *
 * Contexto:
 *   O delivery check tinha 2 bugs (corrigidos no PR junto deste script):
 *     1. Marcava `retry_attempted_at` na msg mais recente do conversation, não
 *        na que efetivamente estava no ghost chat. Se o atendente mandou 2
 *        msgs rápido, a 2ª era marcada erroneamente e a 1ª ficava órfã.
 *     2. Só re-enviava a 1ª msg na variante alternativa. Msgs subsequentes
 *        que o atendente mandou antes do delivery check ficavam presas no
 *        chat fantasma — nunca chegavam ao lead, mas apareciam como enviadas.
 *
 * Backfill (este script):
 *   Identifica conversations onde:
 *     - Existe AO MENOS 1 msg outbound com retry_attempted_at != NULL
 *     - Existem outras msgs outbound NÃO marcadas com delivered=false
 *       (essas são as órfãs)
 *   Marca TODAS essas msgs com failed_at + failed_reason='ghost_chat'.
 *
 * NÃO re-envia nada — só corrige o estado pra UI mostrar com badge correto.
 * Reenvio fica a critério do atendente.
 *
 * Uso: railway run node scripts/backfill-ghost-chat-messages.js [--dry-run]
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    console.log(DRY_RUN ? '[DRY RUN]' : '[LIVE]', 'backfill ghost_chat messages');

    // 1. Acha conversations afetadas: têm retry + têm outras msgs undelivered não-marcadas
    const { data: convsWithRetry, error: e1 } = await supabase
        .from('messages')
        .select('conversation_id, retry_attempted_at')
        .not('retry_attempted_at', 'is', null);
    if (e1) { console.error(e1); process.exit(1); }

    const retryByConv = new Map();
    for (const m of convsWithRetry) {
        const cur = retryByConv.get(m.conversation_id);
        if (!cur || m.retry_attempted_at < cur) {
            retryByConv.set(m.conversation_id, m.retry_attempted_at);
        }
    }
    const candidateConvs = [...retryByConv.entries()];
    console.log(`${candidateConvs.length} conversations com retry; analisando órfãs...`);

    let affected = 0, totalMsgs = 0, errors = 0;
    // Janela de segurança: msgs criadas nos últimos 5s antes do retry podem ser
    // a própria msg re-enviada (que entra via webhook do Unipile com timestamp
    // muito próximo do retry_attempted_at). Tudo CERTAMENTE órfão fica criado
    // ANTES dessa janela.
    const SAFE_WINDOW_MS = 5_000;

    for (const [convId, retryAt] of candidateConvs) {
        try {
            const cutoff = new Date(new Date(retryAt).getTime() - SAFE_WINDOW_MS).toISOString();
            // Filtro conservador: só marca msgs que CERTAMENTE foram órfãs do bug
            // (delivered=false, sem retry/failed marcado, criadas antes da janela).
            // Casos ambíguos (ex: msg marcada erroneamente como retry pelo bug —
            // "Falo com a Liana?") ficam de fora — atendente revisa caso a caso.
            const { data: orphans, error } = await supabase
                .from('messages')
                .select('id, content, created_at, delivered')
                .eq('conversation_id', convId)
                .eq('direction', 'outbound')
                .eq('delivered', false)
                .is('retry_attempted_at', null)
                .is('failed_at', null)
                .lt('created_at', cutoff)
                .order('created_at');
            if (error) throw error;
            const toMark = orphans || [];

            if (toMark.length === 0) continue;

            console.log(`  conv ${convId.slice(0,8)} → ${toMark.length} msg(s) órfã(s):`);
            for (const m of toMark) {
                const preview = (m.content || '').slice(0, 50).replace(/\n/g, ' ');
                console.log(`    [${m.created_at.slice(11,19)}] ${preview}`);
            }

            if (!DRY_RUN) {
                const ids = toMark.map(m => m.id);
                const nowIso = new Date().toISOString();
                const { error: upErr } = await supabase
                    .from('messages')
                    .update({
                        failed_at:          nowIso,
                        failed_reason:      'ghost_chat',
                        retry_attempted_at: nowIso, // alinha com a msg que já estava marcada
                    })
                    .in('id', ids);
                if (upErr) throw upErr;
            }

            affected++;
            totalMsgs += toMark.length;
        } catch (err) {
            console.error(`  ERRO conv ${convId.slice(0,8)}: ${err.message}`);
            errors++;
        }
    }

    console.log('\n──── resumo ────');
    console.log(`conversations afetadas: ${affected}`);
    console.log(`msgs marcadas:           ${totalMsgs}`);
    console.log(`erros:                   ${errors}`);
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
