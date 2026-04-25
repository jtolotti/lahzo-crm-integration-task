-- Add role column to users table (default: 'operator')
CREATE TYPE user_role AS ENUM ('admin', 'operator');

ALTER TABLE users ADD COLUMN role user_role NOT NULL DEFAULT 'operator';

-- Promote admin@lahzo.dev to admin role
UPDATE users SET role = 'admin' WHERE email = 'admin@lahzo.dev';
