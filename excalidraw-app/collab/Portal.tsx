import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { encryptData } from "@excalidraw/excalidraw/data/encryption";
import { newElementWith } from "@excalidraw/element";
import throttle from "lodash.throttle";

import { randomId, type UserIdleState } from "@excalidraw/common";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  OnUserFollowedPayload,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { WS_EVENTS, FILE_UPLOAD_TIMEOUT, WS_SUBTYPES } from "../app_constants";
import { isSyncableElement } from "../data";

import type {
  SocketUpdateData,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";
import type { TCollabClass } from "./Collab";

interface ESocket {
  e_type: string,
  data: {
    socketId: string,
    clients: SocketId[]
  }
}

class Portal {
  collab: TCollabClass;
  socket: WebSocket | null = null;
  socketInitialized: boolean = false; // we don't want the socket to emit any updates until it is fully initialized
  roomId: string | null = null;
  roomKey: string | null = null;
  SocketId: string | null = null;
  onCallBackMessage: any;
  // onCallBackMessage : Function 
  broadcastedElementVersions: Map<string, number> = new Map();
  constructor(collab: TCollabClass) {
    this.collab = collab;
  }

  open(socket: WebSocket, id: string, key: string) {
    this.socket = socket;
    this.roomId = id;
    this.roomKey = key;
    this.SocketId = randomId();
    this.socket.onopen = () => {
      console.log("connected");
    }
    //   let count = 0;
    this.socket.onmessage = (event) => {
      //     console.log("count", count, ":", event.data);

      const { e_type, data } = JSON.parse(event.data);

      switch (e_type) {
        case "init-room":
          handleInitRoom(this);
          break;
        case "new-user":
          handleNewUser(this, data.socketId);
          break;
        case "room-user-change":
          handleRoomUserChange(this, data.clients);
          break;
        default:
          //  console.log(e_type);
          this.onCallBackMessage(event);
          break;

      }
    }
    // Initialize socket listeners
    function handleInitRoom(portal: Portal) {
      if (portal.socket) {
        const initRoomData = {
          e_type: "join-room",
          roomId: portal.roomId
        }
        socket.send(JSON.stringify(initRoomData));
        trackEvent("share", "room joined");
      }
    };

    // this.socket.on("new-user", async (_socketId: string) => {
    //   this.broadcastScene(
    //     WS_SUBTYPES.INIT,
    //     this.collab.getSceneElementsIncludingDeleted(),
    //     /* syncAll */ true,
    //   );
    // });

    const handleNewUser = async (portal: Portal, _socketId: string) => {
      if (portal.socket) {
        portal.broadcastScene(
          WS_SUBTYPES.INIT,
          portal.collab.getSceneElementsIncludingDeleted(),
          /* syncAll */ true,
        );
      }
    };

    // this.socket.on("room-user-change", (clients: SocketId[]) => {
    //   this.collab.setCollaborators(clients);
    // });

    function handleRoomUserChange(portal: Portal, clients: SocketId[]) {
      if (portal.socket) {
        portal.collab.setCollaborators(clients);
      }
    }

    return socket;
  }

  close() {
    if (!this.socket) {
      return;
    }
    this.queueFileUpload.flush();
    this.socket.close();
    this.socket = null;
    this.roomId = null;
    this.roomKey = null;
    this.socketInitialized = false;
    this.broadcastedElementVersions = new Map();
  }

  isOpen() {
    return !!(
      this.socketInitialized &&
      this.socket &&
      this.roomId &&
      this.roomKey
    );
  }

  async _broadcastSocketData(
    data: SocketUpdateData,
    volatile: boolean = false,
    roomId?: string,
  ) {
    if (this.isOpen()) {
      const json = JSON.stringify(data);
      const encoded = new TextEncoder().encode(json);
      const { encryptedBuffer, iv } = await encryptData(this.roomKey!, encoded);
      // console.log(encryptedBuffer);
      const s_data = {
        socketId: this.SocketId,
        e_type: volatile ? WS_EVENTS.SERVER_VOLATILE : WS_EVENTS.SERVER,
        roomId: roomId ?? this.roomId,
        encryptedBuffer: Array.from(new Uint8Array(encryptedBuffer)),
        iv: Array.from(iv),
      }
      this.socket?.send(
        JSON.stringify(s_data)
      );
    }
  }

  queueFileUpload = throttle(async () => {
    try {
      await this.collab.fileManager.saveFiles({
        elements: this.collab.excalidrawAPI.getSceneElementsIncludingDeleted(),
        files: this.collab.excalidrawAPI.getFiles(),
      });
    } catch (error: any) {
      if (error.name !== "AbortError") {
        this.collab.excalidrawAPI.updateScene({
          appState: {
            errorMessage: error.message,
          },
        });
      }
    }

    let isChanged = false;
    const newElements = this.collab.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (this.collab.fileManager.shouldUpdateImageElementStatus(element)) {
          isChanged = true;
          // this will signal collaborators to pull image data from server
          // (using mutation instead of newElementWith otherwise it'd break
          // in-progress dragging)
          return newElementWith(element, { status: "saved" });
        }
        return element;
      });

    if (isChanged) {
      this.collab.excalidrawAPI.updateScene({
        elements: newElements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, FILE_UPLOAD_TIMEOUT);

  broadcastScene = async (
    updateType: WS_SUBTYPES.INIT | WS_SUBTYPES.UPDATE,
    elements: readonly OrderedExcalidrawElement[],
    syncAll: boolean,
  ) => {
    if (updateType === WS_SUBTYPES.INIT && !syncAll) {
      throw new Error("syncAll must be true when sending SCENE.INIT");
    }

    // sync out only the elements we think we need to to save bandwidth.
    // periodically we'll resync the whole thing to make sure no one diverges
    // due to a dropped message (server goes down etc).
    const syncableElements = elements.reduce((acc, element) => {
      if (
        (syncAll ||
          !this.broadcastedElementVersions.has(element.id) ||
          element.version > this.broadcastedElementVersions.get(element.id)!) &&
        isSyncableElement(element)
      ) {
        acc.push(element);
      }
      return acc;
    }, [] as SyncableExcalidrawElement[]);

    const data: SocketUpdateDataSource[typeof updateType] = {
      type: updateType,
      payload: {
        elements: syncableElements,
      },
    };

    for (const syncableElement of syncableElements) {
      this.broadcastedElementVersions.set(
        syncableElement.id,
        syncableElement.version,
      );
    }

    this.queueFileUpload();

    await this._broadcastSocketData(data as SocketUpdateData);
  };

  broadcastIdleChange = (userState: UserIdleState) => {
    if (this.SocketId) {
      const data: SocketUpdateDataSource["IDLE_STATUS"] = {
        type: WS_SUBTYPES.IDLE_STATUS,
        payload: {
          socketId: this.SocketId as SocketId,
          userState,
          username: this.collab.state.username,
        },
      };
      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
      );
    }
  };

  broadcastMouseLocation = (payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
  }) => {

    if (this.SocketId) {
      const data: SocketUpdateDataSource["MOUSE_LOCATION"] = {
        type: WS_SUBTYPES.MOUSE_LOCATION,
        payload: {
          socketId: this.SocketId as SocketId,
          pointer: payload.pointer,
          button: payload.button || "up",
          selectedElementIds:
            this.collab.excalidrawAPI.getAppState().selectedElementIds,
          username: this.collab.state.username,
        },
      };

      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
      );
    }
  };

  broadcastVisibleSceneBounds = (
    payload: {
      sceneBounds: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"]["payload"]["sceneBounds"];
    },
    roomId: string,
  ) => {
    if (this.SocketId) {
      const data: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"] = {
        type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
        payload: {
          socketId: this.SocketId as SocketId,
          username: this.collab.state.username,
          sceneBounds: payload.sceneBounds,
        },
      };

      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
        roomId,
      );
    }
  };

  broadcastUserFollowed = (payload: OnUserFollowedPayload) => {
    if (this.SocketId) {
      const userf_payload = {
        type: WS_EVENTS.USER_FOLLOW_CHANGE,
        data: payload
      }
      this.socket?.send(JSON.stringify(userf_payload));
    }
  };
}

export default Portal;