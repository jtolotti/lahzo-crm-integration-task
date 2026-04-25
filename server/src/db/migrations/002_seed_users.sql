-- Seed operator accounts (passwords hashed with bcrypt, 12 rounds)
-- admin@lahzo.dev / admin123
-- reviewer@lahzo.dev / reviewer123
INSERT INTO users (email, password_hash, name) VALUES
  ('admin@lahzo.dev',    '$2b$12$G9lwYEh2UKtNM9853JRycOSzK9y3VDdl/ZMB3aAq.8msNei61SUm2', 'Admin'),
  ('reviewer@lahzo.dev', '$2b$12$ynI6t6VHuzuxfz1QqfnhBevLL2RYOmEATVuPFW.tNICLCc0IW02qO', 'Reviewer')
ON CONFLICT (email) DO NOTHING;
