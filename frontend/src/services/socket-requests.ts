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
  ManhuntLocationAcknowledgementPayload,
  CountdownSyncResponsePayload,
} from "@impostor/api";
import { connectSocket, getSocketClient } from "./socket-client";
import type {
  AcknowledgedClientEvent,
  AcknowledgementData,
  SocketAcknowledgement,
} from "./socket-types";

const ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;

type AcknowledgedRequest<Event extends AcknowledgedClientEvent> = {
  event: Event;
  payload: ClientToServerPayloads[Event];
};

type AnyAcknowledgedRequest = {
  [Event in AcknowledgedClientEvent]: AcknowledgedRequest<Event>;
}[AcknowledgedClientEvent];

type RequestFor<Event extends AcknowledgedClientEvent> = Extract<
  AnyAcknowledgedRequest,
  { event: Event }
>;

export function emitWithAcknowledgement(
  request: RequestFor<typeof ROOM_EVENTS.CREATE>,
): Promise<SocketAcknowledgement<CreateRoomResponse>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof ROOM_EVENTS.JOIN>,
): Promise<SocketAcknowledgement<JoinRoomResponse>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof ROOM_EVENTS.LEAVE>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof ROOM_EVENTS.UPDATE_SETTINGS>,
): Promise<SocketAcknowledgement<RoomUpdatePayload>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof ROOM_EVENTS.RETURN_TO_LOBBY>,
): Promise<SocketAcknowledgement<RoomUpdatePayload>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof CONNECTION_EVENTS.RECONNECT>,
): Promise<SocketAcknowledgement<PlayerReconnectedPayload>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof GAME_EVENTS.START_GAME>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof CLOCK_EVENTS.SYNC>,
): Promise<SocketAcknowledgement<ClockSyncResponsePayload>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.UPDATE_SETTINGS>,
): Promise<SocketAcknowledgement<RoomUpdatePayload>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.LOCATION_UPDATE>,
): Promise<SocketAcknowledgement<ManhuntLocationAcknowledgementPayload>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.FREEZE>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.FOOTSTEPS>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.SMOKE_BOMB>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.GHOST>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.FREEZE_DECOY>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE>,
): Promise<SocketAcknowledgement<void>>;
export function emitWithAcknowledgement(
  request: RequestFor<typeof MANHUNT_EVENTS.COUNTDOWN_SYNC>,
): Promise<SocketAcknowledgement<CountdownSyncResponsePayload>>;
export function emitWithAcknowledgement(
  request: AnyAcknowledgedRequest,
): Promise<
  SocketAcknowledgement<
    AcknowledgementData<AcknowledgedClientEvent>
  >
> {
  const socket = getSocketClient();
  connectSocket();

  switch (request.event) {
    case ROOM_EVENTS.CREATE:
      return sendAcknowledged((acknowledge) =>
        socket.emit(ROOM_EVENTS.CREATE, request.payload, acknowledge),
      );
    case ROOM_EVENTS.JOIN:
      return sendAcknowledged((acknowledge) =>
        socket.emit(ROOM_EVENTS.JOIN, request.payload, acknowledge),
      );
    case ROOM_EVENTS.LEAVE:
      return sendAcknowledged((acknowledge) =>
        socket.emit(ROOM_EVENTS.LEAVE, request.payload, acknowledge),
      );
    case ROOM_EVENTS.UPDATE_SETTINGS:
      return sendAcknowledged((acknowledge) =>
        socket.emit(ROOM_EVENTS.UPDATE_SETTINGS, request.payload, acknowledge),
      );
    case ROOM_EVENTS.RETURN_TO_LOBBY:
      return sendAcknowledged((acknowledge) =>
        socket.emit(ROOM_EVENTS.RETURN_TO_LOBBY, request.payload, acknowledge),
      );
    case CONNECTION_EVENTS.RECONNECT:
      return sendAcknowledged((acknowledge) =>
        socket.emit(CONNECTION_EVENTS.RECONNECT, request.payload, acknowledge),
      );
    case GAME_EVENTS.START_GAME:
      return sendAcknowledged((acknowledge) =>
        socket.emit(GAME_EVENTS.START_GAME, request.payload, acknowledge),
      );
    case CLOCK_EVENTS.SYNC:
      return sendAcknowledged((acknowledge) =>
        socket.emit(CLOCK_EVENTS.SYNC, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.UPDATE_SETTINGS:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.UPDATE_SETTINGS, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.LOCATION_UPDATE:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.LOCATION_UPDATE, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.FREEZE:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.FREEZE, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.FOOTSTEPS:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.FOOTSTEPS, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.SMOKE_BOMB:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.SMOKE_BOMB, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.GHOST:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.GHOST, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.FREEZE_DECOY:
      return sendAcknowledged((acknowledge) =>
        socket.emit(MANHUNT_EVENTS.FREEZE_DECOY, request.payload, acknowledge),
      );
    case MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE:
      return sendAcknowledged((acknowledge) =>
        socket.emit(
          MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE,
          request.payload,
          acknowledge,
        ),
      );
    case MANHUNT_EVENTS.COUNTDOWN_SYNC:
      return sendAcknowledged((acknowledge) =>
        socket.emit(
          MANHUNT_EVENTS.COUNTDOWN_SYNC,
          request.payload,
          acknowledge,
        ),
      );
  }
}

function sendAcknowledged<Event extends AcknowledgedClientEvent>(
  send: (
    acknowledgement: (
      response: SocketAcknowledgement<AcknowledgementData<Event>>,
    ) => void,
  ) => void,
): Promise<SocketAcknowledgement<AcknowledgementData<Event>>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("The server did not respond. Check your connection and retry."),
      );
    }, ACKNOWLEDGEMENT_TIMEOUT_MS);

    send((response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}
