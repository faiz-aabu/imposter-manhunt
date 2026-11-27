import {
  CLOCK_EVENTS,
  CONNECTION_EVENTS,
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
} from "@impostor/api";
import type {
  ClientToServerPayloads,
  ClockSyncResponsePayload,
  CreateRoomResponse,
  JoinRoomResponse,
  PlayerId,
  PlayerReconnectedPayload,
  RoomCode,
  RoomUpdatePayload,
  ServerErrorPayload,
  ServerToClientPayloads,
  ManhuntLocationAcknowledgementPayload,
  CountdownSyncResponsePayload,
} from "@impostor/api";
import type { Server, Socket } from "socket.io";

export type SocketAcknowledgement<T> =
  | { ok: true; data: T }
  | { ok: false; error: ServerErrorPayload };

export type SocketAck<T> = (result: SocketAcknowledgement<T>) => void;

export interface ClientToServerEvents {
  [CLOCK_EVENTS.SYNC]: (
    payload: ClientToServerPayloads[typeof CLOCK_EVENTS.SYNC],
    acknowledgement?: SocketAck<ClockSyncResponsePayload>,
  ) => void;
  [ROOM_EVENTS.CREATE]: (
    payload: ClientToServerPayloads[typeof ROOM_EVENTS.CREATE],
    acknowledgement?: SocketAck<CreateRoomResponse>,
  ) => void;
  [ROOM_EVENTS.JOIN]: (
    payload: ClientToServerPayloads[typeof ROOM_EVENTS.JOIN],
    acknowledgement?: SocketAck<JoinRoomResponse>,
  ) => void;
  [ROOM_EVENTS.LEAVE]: (
    payload: ClientToServerPayloads[typeof ROOM_EVENTS.LEAVE],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [ROOM_EVENTS.UPDATE_SETTINGS]: (
    payload: ClientToServerPayloads[typeof ROOM_EVENTS.UPDATE_SETTINGS],
    acknowledgement?: SocketAck<RoomUpdatePayload>,
  ) => void;
  [ROOM_EVENTS.RETURN_TO_LOBBY]: (
    payload: ClientToServerPayloads[typeof ROOM_EVENTS.RETURN_TO_LOBBY],
    acknowledgement?: SocketAck<RoomUpdatePayload>,
  ) => void;
  [CONNECTION_EVENTS.RECONNECT]: (
    payload: ClientToServerPayloads[typeof CONNECTION_EVENTS.RECONNECT],
    acknowledgement?: SocketAck<PlayerReconnectedPayload>,
  ) => void;
  [GAME_EVENTS.START_GAME]: (
    payload: ClientToServerPayloads[typeof GAME_EVENTS.START_GAME],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [IMPOSTOR_EVENTS.VOTE_SUBMISSION]: (
    payload: ClientToServerPayloads[typeof IMPOSTOR_EVENTS.VOTE_SUBMISSION],
  ) => void;
  [IMPOSTOR_EVENTS.ROLE_REQUEST]: (
    payload: ClientToServerPayloads[typeof IMPOSTOR_EVENTS.ROLE_REQUEST],
  ) => void;
  [WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION]: (
    payload: ClientToServerPayloads[typeof WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION],
  ) => void;
  [WORD_IMPOSTOR_EVENTS.ROLE_REQUEST]: (
    payload: ClientToServerPayloads[typeof WORD_IMPOSTOR_EVENTS.ROLE_REQUEST],
  ) => void;
  [MANHUNT_EVENTS.UPDATE_SETTINGS]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.UPDATE_SETTINGS],
    acknowledgement?: SocketAck<RoomUpdatePayload>,
  ) => void;
  [MANHUNT_EVENTS.LOCATION_UPDATE]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.LOCATION_UPDATE],
    acknowledgement?: SocketAck<ManhuntLocationAcknowledgementPayload>,
  ) => void;
  [MANHUNT_EVENTS.FREEZE]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.FREEZE],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [MANHUNT_EVENTS.FOOTSTEPS]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.FOOTSTEPS],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [MANHUNT_EVENTS.SMOKE_BOMB]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.SMOKE_BOMB],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [MANHUNT_EVENTS.GHOST]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.GHOST],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [MANHUNT_EVENTS.FREEZE_DECOY]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.FREEZE_DECOY],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [MANHUNT_EVENTS.READY_UPDATE]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.READY_UPDATE],
  ) => void;
  [MANHUNT_EVENTS.CATCH]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.CATCH],
  ) => void;
  [MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE],
    acknowledgement?: SocketAck<void>,
  ) => void;
  [MANHUNT_EVENTS.COUNTDOWN_SYNC]: (
    payload: ClientToServerPayloads[typeof MANHUNT_EVENTS.COUNTDOWN_SYNC],
    acknowledgement?: SocketAck<CountdownSyncResponsePayload>,
  ) => void;
}

export type ServerToClientEvents = {
  [Event in Exclude<
    keyof ServerToClientPayloads,
    typeof CONNECTION_EVENTS.DISCONNECT
  >]: (payload: ServerToClientPayloads[Event]) => void;
};

export interface InterServerEvents {}

export interface SocketData {
  playerId?: PlayerId;
  roomCode?: RoomCode;
}

export type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type GameSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
