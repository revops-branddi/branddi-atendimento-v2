-- Migration 012: site flow — re-habilita bot de triagem.
--
-- Migration 008 desabilitou o bot ('100% humano'). Agora reabilitamos pra
-- fluxo de triagem inicial em /site (NÃO é o bot de prospecção, que
-- continua proibido — ver memory/feedback_no_auto_messages.md).
--
-- O bot do /site:
--   1. Cumprimenta lead que chegou via wa.me
--   2. Pergunta se é "OPEC" (recebeu notificação) ou "Comercial" (interesse)
--   3. Se OPEC → pergunta qual email notificou (3 opções) → roteia GChat
--   4. Se Comercial → pergunta nome/empresa/interesse → entrega pra atendente
--
-- bot_stage states:
--   'welcome'                  → ainda não enviou greeting; próxima inbound dispara
--   'awaiting_classification'  → enviou greeting, espera "1" ou "2"
--   'awaiting_email_choice'    → OPEC: espera "1" / "2" / "3" pra escolher email
--   'awaiting_commercial_details' → Comercial: espera resposta com nome/empresa/interesse
--   'human'                    → bot saiu, atendente assume
--
-- Reverter:
--   ALTER TABLE site.conversations DROP CONSTRAINT IF EXISTS site_conversations_bot_stage_check;
--   ALTER TABLE site.conversations DROP CONSTRAINT IF EXISTS site_conversations_status_check;
--   ALTER TABLE site.conversations ADD CONSTRAINT site_conversations_status_check
--     CHECK (status IN ('waiting_human','in_progress','resolved'));
--   ALTER TABLE site.conversations ALTER COLUMN status SET DEFAULT 'waiting_human';

-- Status: aceita 'bot' de novo. Default volta a ser 'bot' (toda conv nova
-- entra no bot, que decide pra onde vai). Conversas existentes ficam como
-- estão.
ALTER TABLE site.conversations DROP CONSTRAINT IF EXISTS site_conversations_status_check;
ALTER TABLE site.conversations
    ADD CONSTRAINT site_conversations_status_check
    CHECK (status IN ('bot', 'waiting_human', 'in_progress', 'resolved'));

ALTER TABLE site.conversations ALTER COLUMN status SET DEFAULT 'bot';

-- bot_stage: re-adiciona CHECK com novos estados. Default 'welcome' pra que
-- conv recém-criada saiba que tem que enviar greeting.
ALTER TABLE site.conversations DROP CONSTRAINT IF EXISTS site_conversations_bot_stage_check;
ALTER TABLE site.conversations
    ADD CONSTRAINT site_conversations_bot_stage_check
    CHECK (bot_stage IS NULL OR bot_stage IN (
        'welcome',
        'awaiting_classification',
        'awaiting_email_choice',
        'awaiting_commercial_details',
        'human'
    ));

ALTER TABLE site.conversations ALTER COLUMN bot_stage SET DEFAULT 'welcome';

-- bot_attempts: contador pra fallback. Após 3 respostas inesperadas, bot
-- desiste e entrega pra humano (status='waiting_human', bot_stage='human').
ALTER TABLE site.conversations
    ADD COLUMN IF NOT EXISTS bot_attempts integer DEFAULT 0 NOT NULL;
