import type { ApiErrorCode } from "@impostor/api";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  NOT_AUTHORIZED: 403,
  GAME_NOT_ACTIVE: 409,
  GAME_NOT_READY: 409,
  DUPLICATE_VOTE: 409,
  INVALID_VOTE: 400,
  INVALID_PAYLOAD: 400,
  UNKNOWN: 500,
};

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    statusCode = STATUS_BY_CODE[code],
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}
