import type { ISODateString, Room } from "./types/index.js";
import type { ApiErrorCode } from "./payloads.js";

export interface GetHealthResponse {
  status: "ok";
  timestamp: ISODateString;
}

export interface GuestProfile {
  id: string;
  nickname: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateGuestProfileRequest {
  nickname: string;
}

export interface CreateGuestProfileResponse {
  profile: GuestProfile;
  credential: string;
}

export interface RestoreGuestProfileRequest {
  credential: string;
}

export interface RestoreGuestProfileResponse {
  profile: GuestProfile;
}

export interface LinkGuestProfileRequest {
  credential: string;
}

export interface LinkGuestProfileResponse {
  profile: GuestProfile;
}

export type GetRoomResponse = Room;

export interface RestErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
