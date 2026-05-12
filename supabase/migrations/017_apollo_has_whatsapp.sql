-- Migration 017: Marca presença de WhatsApp em apollo_enrichments
--
-- Hoje o usuário só descobre que o número devolvido pelo Apollo não tem
-- WhatsApp ao tentar enviar a mensagem (Unipile devolve 422
-- errors/invalid_recipient). Já se digitou texto e perdeu tempo.
--
-- Vamos checar pró-ativamente via GET /users/{phone}?account_id=...
-- (lookup read-only, não notifica o destinatário) logo que o phone chega do
-- Apollo. Resultado fica gravado aqui pra UI sinalizar antes do clique e pra
-- não re-checar a cada reload do modal.
--
-- has_whatsapp:
--   true  → número tem WhatsApp ativo (Unipile retornou perfil)
--   false → Unipile devolveu 404 — número NÃO tem WA
--   NULL  → não checado, Unipile indisponível, ou checagem ainda pendente
--           (UI trata como "verificação indisponível" — não bloqueia clique)

ALTER TABLE apollo_enrichments
    ADD COLUMN IF NOT EXISTS has_whatsapp boolean;

COMMENT ON COLUMN apollo_enrichments.has_whatsapp IS
    'Resultado do check pró-ativo de presença no WhatsApp via Unipile GET /users/{phone}. true=tem WA, false=não tem, NULL=não checado ou erro transitório.';
