use bytes::Bytes;
use serde::{Deserialize, Serialize};
#[derive(Debug, Serialize, Deserialize)]
pub struct ESocket {
    pub e_type: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct BodySocket {
    pub socketId : String,
    pub e_type: String,
    pub roomId: String,
    pub encryptedBuffer: Bytes,
    pub iv: Bytes,
}


impl ESocket {
    pub fn new(event: String) -> Self {
        Self { e_type: event }
    }
}

