import {
  CLOCK_EVENTS,
  CONNECTION_EVENTS,
  GAME_EVENTS,
  ROOM_EVENTS,
  MANHUNT_EVENTS,
} from "@impostor/api";
import type {
  ClientToServerPayloads,
  ClockSyncResponsePayload,
  CreateRoomResponse,
  JoinRoomResponse,
  PlayerReconnectedPayload,
  RoomUpdatePayload,
  ServerErrorPayload,
  ServerToClientPayloads,
  ManhuntLocationAcknowledgementPayload,
  CountdownSyncResponsePayload,
} from "@impostor/api";
import type { Socket } from "socket.io-client";

export type SocketAcknowledgement<T> =
  | { ok: true; data: T }
  | { ok: false; error: ServerErrorPayload };

export type AcknowledgedClientEvent =
  | typeof CLOCK_EVENTS.SYNC
  | typeof ROOM_EVENTS.CREATE
  | typeof ROOM_EVENTS.JOIN
  | typeof ROOM_EVENTS.LEAVE
  | typeof ROOM_EVENTS.UPDATE_SETTINGS
  | typeof ROOM_EVENTS.RETURN_TO_LOBBY
  | typeof CONNECTION_EVENTS.RECONNECT
  | typeof GAME_EVENTS.START_GAME
  | typeof MANHUNT_EVENTS.UPDATE_SETTINGS
  | typeof MANHUNT_EVENTS.LOCATION_UPDATE
  | typeof MANHUNT_EVENTS.FREEZE
  | typeof MANHUNT_EVENTS.FOOTSTEPS
  | typeof MANHUNT_EVENTS.SMOKE_BOMB
  | typeof MANHUNT_EVENTS.GHOST
  | typeof MANHUNT_EVENTS.FREEZE_DECOY
  | typeof MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE
  | typeof MANHUNT_EVENTS.COUNTDOWN_SYNC;

export type AcknowledgementData<Event extends AcknowledgedClientEvent> =
  Event extends typeof CLOCK_EVENTS.SYNC
    ? ClockSyncResponsePayload
    : Event extends typeof ROOM_EVENTS.CREATE
    ? CreateRoomResponse
    : Event extends typeof ROOM_EVENTS.JOIN
      ? JoinRoomResponse
      : Event extends typeof ROOM_EVENTS.LEAVE
        ? void
        : Event extends typeof ROOM_EVENTS.UPDATE_SETTINGS
          ? RoomUpdatePayload
          : Event extends typeof ROOM_EVENTS.RETURN_TO_LOBBY
            ? RoomUpdatePayload
            : Event extends typeof CONNECTION_EVENTS.RECONNECT
              ? PlayerReconnectedPayload
              : Event extends typeof MANHUNT_EVENTS.UPDATE_SETTINGS
                ? RoomUpdatePayload
                : Event extends typeof MANHUNT_EVENTS.LOCATION_UPDATE
                  ? ManhuntLocationAcknowledgementPayload
                  : Event extends typeof MANHUNT_EVENTS.FREEZE
                    ? void
                    : Event extends typeof MANHUNT_EVENTS.FOOTSTEPS
                      ? void
                      : Event extends typeof MANHUNT_EVENTS.SMOKE_BOMB
                        ? void
                        : Event extends typeof MANHUNT_EVENTS.GHOST
                          ? void
                          : Event extends typeof MANHUNT_EVENTS.FREEZE_DECOY
                            ? void
                            : Event extends typeof MANHUNT_EVENTS.COUNTDOWN_SYNC
                              ? CountdownSyncResponsePayload
                              : void;

export type ClientToServerEvents = {
  [Event in keyof ClientToServerPayloads]: Event extends AcknowledgedClientEvent
    ? (
        payload: ClientToServerPayloads[Event],
        acknowledgement?: (
          result: SocketAcknowledgement<AcknowledgementData<Event>>
        ) => void,
      ) => void
    : (payload: ClientToServerPayloads[Event]) => void;
};

type ServerEventName = Exclude<
  keyof ServerToClientPayloads,
  typeof CONNECTION_EVENTS.DISCONNECT
>;

export type ServerToClientEvents = {
  [Event in ServerEventName]: (
    payload: ServerToClientPayloads[Event]
  ) => void;
};

export type GameClientSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;
