use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    routing::get,
};

use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{
    Mutex,
    broadcast::{self, Receiver, Sender},
};

use std::net::SocketAddr;
use tracing::info;
use web_socket::model::Esocket::{BodySocket, ESocket};

#[derive(Debug, Clone)]
struct Appstate {
    rooms: Arc<Mutex<HashMap<String, Sender<Message>>>>,
}

async fn handle_socket(socket: WebSocket, stateapp: Appstate) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let esocket = serde_json::to_string(&ESocket::new("init-room".to_string())).unwrap();
    println!("event : {}", esocket);
    if ws_tx.send(Message::Text(esocket.into())).await.is_err() {
        println!("failed to create room");
    } else {
        println!("send success");
    }

    let ws_tx = Arc::new(Mutex::new(ws_tx));
    recv_from_client(ws_rx, stateapp, ws_tx.clone()).await;
}

async fn recv_from_client(
    mut client_rx: SplitStream<WebSocket>,
    stateapp: Appstate,
    ws_tx: Arc<Mutex<SplitSink<WebSocket, Message>>>,
) {
    while let Some(Ok(msg)) = client_rx.next().await {
        let ws_tx = ws_tx.clone();
        match msg {
            Message::Text(ref msg) => {
                let check = serde_json::from_str::<serde_json::Value>(&msg).unwrap();
                if let Some(e_type) = check.get("e_type") {
                    if e_type.eq("server-volatile-broadcast") {
                        let mut recv_data = serde_json::from_str::<BodySocket>(&msg).unwrap();
                        // broadcast to all user
                        recv_data.e_type = "client-broadcast".to_string();
                        let new_send_back_data = serde_json::to_string(&recv_data).unwrap();
                        //roomid
                        let room_id = check.get("roomId").unwrap();
                        if stateapp
                            .rooms
                            .lock()
                            .await
                            .get(room_id.as_str().unwrap())
                            .unwrap()
                            .send(Message::Text(new_send_back_data.into()))
                            .is_err()
                        {
                            println!("failed to broadcast message");
                        }
                    }
                    if e_type.eq("join-room") {
                        println!("join-room : {}", check.get("roomId").unwrap());
                        let room_id = check.get("roomId").unwrap();

                        if stateapp
                            .rooms
                            .lock()
                            .await
                            .contains_key(room_id.as_str().unwrap())
                        {
                            let broadcast_rx = stateapp
                                .rooms
                                .lock()
                                .await
                                .get(room_id.as_str().unwrap())
                                .unwrap()
                                .subscribe();
                            tokio::spawn(async move {
                                recv_broadcast(ws_tx, broadcast_rx).await;
                            });
                            println!("room already exists");
                        } else {
                            let (tx, _) = broadcast::channel(32);

                            stateapp
                                .rooms
                                .lock()
                                .await
                                .insert(room_id.as_str().unwrap().to_string(), tx);
                            println!("room created : {}", room_id);
                        }
                    }
                }
            }
            Message::Binary(_) => {}
            Message::Pong(_) => {}
            Message::Ping(_) => {}
            Message::Close(_) => {
                println!("Closing Websocket Connection");
            }
        }
    }
}

async fn recv_broadcast(
    client_tx: Arc<Mutex<SplitSink<WebSocket, Message>>>,
    mut broadcast_rx: Receiver<Message>,
) {
    while let Ok(msg) = broadcast_rx.recv().await {
        match msg {
            Message::Text(ref msg) => {
                let mut recv_data = serde_json::from_str::<BodySocket>(&msg).unwrap();
                println!("mes : {:?}", recv_data);
            }
            Message::Binary(_) => {}
            Message::Pong(_) => {}
            Message::Ping(_) => {}
            Message::Close(_) => {
                println!("Closing Websocket Connection");
            }
        }
        if (client_tx.lock().await.send(msg.clone())).await.is_err() {
            return;
        }
    }
}

async fn websocket_upgrade_handler(
    ws: WebSocketUpgrade,
    State(stateapp): State<Appstate>,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, stateapp))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let rooms: HashMap<String, Sender<Message>> = HashMap::new();
    let stateapp = Appstate {
        rooms: Arc::new(Mutex::new(rooms)),
    };

    let app = Router::new()
        .route("/", get(homepage))
        .route("/ws", get(websocket_upgrade_handler))
        .with_state(stateapp);

    let addr = SocketAddr::from(([127, 0, 0, 1], 5000));

    info!("Server start on port 5000");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app.into_make_service())
        .await
        .unwrap();
}

async fn homepage() -> &'static str {
    "hello, world"
}
