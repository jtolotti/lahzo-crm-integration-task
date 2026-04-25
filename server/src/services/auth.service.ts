import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import * as userRepo from '../repositories/user.repository.js';
import { config } from '../config.js';
import { UnauthorizedError } from '../domain/errors.js';

export interface TokenPayload {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'operator';
}

/**
 * Authenticate a user by email and password.
 * Returns a JWT token on success, throws UnauthorizedError on failure.
 */
export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: TokenPayload }> {
  const user = await userRepo.findByEmail(email);
  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const payload: TokenPayload = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };

  const token = jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: '8h',
  });

  return { token, user: payload };
}

/**
 * Verify and decode a JWT token.
 * Returns the payload on success, throws UnauthorizedError on failure.
 */
export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}
