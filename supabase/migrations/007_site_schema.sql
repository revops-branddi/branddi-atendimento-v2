-- Migration 007: site flow — schema isolado para o atendimento que vem do
-- site (lead clica em wa.me/<numero_dedicado>, conversa começa via WhatsApp).
-- Totalmente separado do schema public.* (prospecção). Nenhuma tabela em
-- public é alterada.
--
-- Reverter: DROP SCHEMA site CASCADE;

CREATE SCHEMA IF NOT EXISTS site;

-- ─── WhatsApp accounts (site) ────────────────────────────────────────
-- Conta(s) Unipile dedicada(s) ao número do site. Separada da
-- public.whatsapp_accounts pra garantir que polling de prospecção nunca
-- pegue o número do site e vice-versa.
CREATE TABLE IF NOT EXISTS site.whatsapp_accounts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unipile_account_id      text UNIQUE NOT NULL,
    phone_number            text,
    label                   text,
    status                  text DEFAULT 'active',
    connected_by_user_id    uuid REFERENCES public.platform_users(id),
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);

-- ─── Leads (site) ────────────────────────────────────────────────────
-- Origin típico: 'whatsapp_inbound' (lead clicou em wa.me e mandou msg).
-- origin_metadata pode capturar parâmetros de rastreamento extraídos do
-- texto inicial (ex: ref de página via wa.me?text=<...>).
CREATE TABLE IF NOT EXISTS site.leads (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    text,
    phone                   text,
    email                   text,
    company_name            text,
    domain                  text,
    origin                  text,
    origin_metadata         jsonb DEFAULT '{}'::jsonb,
    working_phone_variant   text CHECK (working_phone_variant IN ('with_9', 'without_9')),
    crm_deal_id             text,
    crm_person_id           text,
    assigned_user_id        uuid REFERENCES public.platform_users(id),
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_leads_phone ON site.leads(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_leads_email ON site.leads(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_leads_deal  ON site.leads(crm_deal_id) WHERE crm_deal_id IS NOT NULL;

-- ─── Conversations (site) ────────────────────────────────────────────
-- whatsapp_account_id armazena o unipile_account_id (text), não FK pra
-- site.whatsapp_accounts.id — mesmo padrão de public.conversations, evita
-- ordering issues durante onboarding de uma nova conta.
-- bot_stage segue o flow rule-based: welcome → qualifying → classified → human.
CREATE TABLE IF NOT EXISTS site.conversations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id                 uuid REFERENCES site.leads(id) ON DELETE CASCADE,
    whatsapp_account_id     text,
    whatsapp_chat_id        text,
    status                  text DEFAULT 'bot' CHECK (status IN ('bot', 'waiting_human', 'in_progress', 'resolved')),
    bot_stage               text DEFAULT 'welcome' CHECK (bot_stage IN ('welcome', 'qualifying', 'classified', 'human')),
    bot_answers             jsonb DEFAULT '{}'::jsonb,
    assigned_user_id        uuid REFERENCES public.platform_users(id),
    last_message_at         timestamptz,
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_conv_chat     ON site.conversations(whatsapp_chat_id) WHERE whatsapp_chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_conv_lead     ON site.conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_site_conv_status   ON site.conversations(status);
CREATE INDEX IF NOT EXISTS idx_site_conv_assigned ON site.conversations(assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_conv_account  ON site.conversations(whatsapp_account_id) WHERE whatsapp_account_id IS NOT NULL;

-- ─── Messages (site) ─────────────────────────────────────────────────
-- unipile_message_id UNIQUE garante dedup do polling. Cascade em delete
-- da conversation pra cleanup natural.
CREATE TABLE IF NOT EXISTS site.messages (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id         uuid REFERENCES site.conversations(id) ON DELETE CASCADE,
    direction               text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    text                    text,
    attachments             jsonb DEFAULT '[]'::jsonb,
    unipile_message_id      text UNIQUE,
    delivered               bool DEFAULT false,
    seen                    bool DEFAULT false,
    sender_type             text CHECK (sender_type IN ('human', 'bot', 'lead')),
    sender_user_id          uuid REFERENCES public.platform_users(id),
    sender_name             text,
    created_at              timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_msgs_conv ON site.messages(conversation_id, created_at DESC);

-- ─── Google Chat threads ─────────────────────────────────────────────
-- 1:1 com conversation. Permite roteamento bidirecional entre nosso inbox
-- e o espaço/thread do GChat usado pelo time interno do site.
CREATE TABLE IF NOT EXISTS site.gchat_threads (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id         uuid UNIQUE REFERENCES site.conversations(id) ON DELETE CASCADE,
    gchat_space_name        text NOT NULL,
    gchat_thread_name       text NOT NULL,
    created_at              timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_gchat_thread ON site.gchat_threads(gchat_thread_name);
