-- Adiciona a coluna email na tabela clients (se ainda não existir)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Índice para facilitar buscas por e-mail (opcional)
CREATE INDEX IF NOT EXISTS clients_email_idx ON clients (email);
