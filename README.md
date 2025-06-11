
## Các Luồng cụ thể

#### 1 lấy room id

```ws
  WS 'init-room' (gửi event init-room để bên frontend nhận event và phát lại event mới join-room truyền roomid cho backend)
```
vd : socket.emit('init-room', "getroom_id")


#### 2 Đưa client vào roomid 

```ws
  WS 'join-room' (nhận event join-room cùng với roomid được gửi và join client-socketid vào roomid này)
```
vd : socket.join(room_id);

#### 3 xử lý real time với mouse pointer của từng client trên whiteboard
```ws
  WS 'server-volatile-broadcast' (nhận event server-volatile-broadcast cùng với data vị trí mousepointer của 1 client nào đó để gửi vị trí này sang client khác cùng room)
```



