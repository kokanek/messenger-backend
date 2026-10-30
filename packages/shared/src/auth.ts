import type { RequestHandler } from "express";
import { SignJWT, jwtVerify } from "jose";
import { AppError } from "./errors.js";
import type { Role } from "./types.js";

// Who made the request, taken from a verified access token.
export interface AuthContext {
  userId: string;
  clientId: string; // the logged-in device
  role: Role;
  displayName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const ISSUER = "messenger-auth";
const AUDIENCE = "messenger";

const secretKey = (secret: string) => new TextEncoder().encode(secret);

// auth-service signs access tokens with this (backend spec, section 10.1).
export async function signAccessToken(secret: string, auth: AuthContext, ttlSeconds: number): Promise<string> {
  return new SignJWT({ cid: auth.clientId, role: auth.role, name: auth.displayName })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(auth.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

// Every service checks tokens itself with the shared secret: no call to auth-service,
// no database lookup. That is what makes a JWT cheap, and also why a logged-out token
// keeps working until it expires (section 10.1).
export async function verifyAccessToken(secret: string, token: string): Promise<AuthContext> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const { sub, cid, role, name } = payload;
    if (
      typeof sub !== "string" ||
      typeof cid !== "string" ||
      (role !== "admin" && role !== "member") ||
      typeof name !== "string"
    ) {
      throw new Error("token is missing claims");
    }
    return { userId: sub, clientId: cid, role, displayName: name };
  } catch {
    throw new AppError("UNAUTHENTICATED", "The access token is missing, invalid or expired");
  }
}

export function requireAuth(secret: string): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError("UNAUTHENTICATED", "Send an access token as: Authorization: Bearer <token>");
    }
    req.auth = await verifyAccessToken(secret, header.slice("Bearer ".length));
    next();
  };
}

// Use after requireAuth.
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.auth?.role !== "admin") {
    throw new AppError("FORBIDDEN", "Only an admin can do this");
  }
  next();
};
