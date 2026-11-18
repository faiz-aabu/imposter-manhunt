import type { ISODateString, Room } from "./types/index.js";
import type { ApiErrorCode } from "./payloads.js";

export interface GetHealthResponse {
  status: "ok";
  timestamp: ISODateString;
}

export type GetRoomResponse = Room;

export interface RestErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
