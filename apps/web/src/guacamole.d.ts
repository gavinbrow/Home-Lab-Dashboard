declare module 'guacamole-common-js' {
 namespace Guacamole {
  interface Status {code:number;message?:string}
  interface MouseState {x:number;y:number;left:boolean;middle:boolean;right:boolean;up:boolean;down:boolean}
  interface Tunnel {}
  class WebSocketTunnel implements Tunnel {constructor(url:string)}
  class HTTPTunnel implements Tunnel {constructor(url:string,crossDomain?:boolean,headers?:Record<string,string>)}
  class ChainedTunnel implements Tunnel {constructor(...tunnels:Tunnel[])}
  class Client {constructor(tunnel:Tunnel);getDisplay():{getElement():HTMLElement};connect(data?:string):void;disconnect():void;sendSize(width:number,height:number):void;sendMouseState(state:MouseState):void;sendKeyEvent(pressed:number,keysym:number):void;onerror:((status:Status)=>void)|null;onstatechange:((state:number)=>void)|null}
  class Mouse {constructor(element:HTMLElement);onmousedown:((state:MouseState)=>void)|null;onmouseup:((state:MouseState)=>void)|null;onmousemove:((state:MouseState)=>void)|null}
  class Keyboard {constructor(element:HTMLElement);onkeydown:((keysym:number)=>boolean)|null;onkeyup:((keysym:number)=>void)|null;reset():void}
 }
 export default Guacamole;
}
