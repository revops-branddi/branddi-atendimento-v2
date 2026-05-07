-- Migration 010: WhatsApp groups (chats com type=1 / @g.us)
-- Grupos viram conversation marcada com is_group=true, sem lead_id vinculado,
-- com subject e participants próprios. Não aparecem no inbox principal —
-- ficam na página dedicada /grupos.

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS group_subject text,
    ADD COLUMN IF NOT EXISTS group_participants jsonb DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_conversations_is_group
    ON conversations(is_group) WHERE is_group = true;

COMMENT ON COLUMN conversations.is_group IS
    'Conversa é um chat de grupo WhatsApp (type=1 / @g.us). Quando true, lead_id pode ser NULL e mensagens usam sender_name real do remetente em vez de lead.name.';

COMMENT ON COLUMN conversations.group_subject IS
    'Nome do grupo (ex: "Renner + Branddi"). Vem do chat.name do Unipile.';

COMMENT ON COLUMN conversations.group_participants IS
    'Lista de membros do grupo: [{ provider_id, name, phone, is_self }]. Atualizado a cada polling cycle pra refletir entradas/saídas.';
