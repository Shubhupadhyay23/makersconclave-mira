-- Seed a demo user so the /chat page works out of the box.
-- Uses a well-known UUID that the frontend defaults to.
INSERT INTO users (id, name, email)
VALUES ('00000000-0000-4000-a000-000000000001', 'Demo User', 'demo@mirrorless.local')
ON CONFLICT (id) DO NOTHING;
