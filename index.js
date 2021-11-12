// load all the libraries for the server
const socketIo = require("socket.io");
const path = require("path");
const fs = require("fs");
const http = require("http");
const cors = require("cors");
const express = require("express");
const ss = require("socket.io-stream");
// load all the libraries for the Dialogflow part
const uuid = require("uuid");
const util = require("util");
const { Transform, pipeline } = require("stream");
const pump = util.promisify(pipeline);
// lib Grpc
const grpc = require("grpc");
const protoLoader = require("@grpc/proto-loader");

const bodyParser = require("body-parser");

// set some server variables
const app = express();
var server;

app.use(bodyParser.json());
app.use(
  bodyParser.urlencoded({
    extended: false,
  })
);
app.use(express.static(__dirname + "/assets"));
app.use(express.static("css"));

// set grpc
var PROTO_PATH = __dirname + "/protos/PartiiService.proto";
var packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
var partii_proto = grpc.loadPackageDefinition(packageDefinition).partii;
var partii_client_list = [];

// config grpc
var grpc_server = "103.51.64.247";
var grpc_port = "27088";
var output = "";
var format = "subtitle"; //subtitle, label
var output_view = "sentent"; //word, phone
var word_index = 0;
var phone_index = 0;
let setting = JSON.parse(
  "{" +
    '"sampling-rate": "16000",' +
    '"vad-threshold": "0.5",' +
    '"num-channels": "1",' +
    '"decode-channels": "0",' +
    '"apikey": "gOvStRM7dLTLkLIXqX1AD15fDeLeg2vb",' +
    '"modelkey": "default",' +
    '"audio-codec": "LINEAR16",' +
    '"protocol": "partii",' +
    '"enable-textnorm": "true",' +
    '"enable-partial": "true",' +
    '"enable-vad": "false",' +
    '"enable-endpoint": "false",' +
    '"number-target": "english",' +
    '"word-or-sentence": "word"' +
    "}"
);
// debug
const debug = 1;
console.log(setting);

/**
 * Setup Express Server with CORS and SocketIO
 */
function setupServer() {
  // setup Express
  app.use(cors());
  app.get("/", function (req, res) {
    res.sendFile(path.join(__dirname + "/index.html"));
  });
  server = http.createServer(app);
  io = socketIo(server);
  server.listen(3000, () => {
    console.log("Running server on port %s", 3000);
  });

  //Nat - Prepare metadata for partii service
  var metadata = new grpc.Metadata();

  for (var key in setting) {
    metadata.add(key, setting[key]);
  }

  // Listener, once the client connect to the server socket
  io.on("connect", (client) => {
    console.log(`Client connected [id=${client.id}]`);

    for (var cid in partii_client_list) {
      console.log(
        "Check client : " +
          cid +
          ", webstatus:" +
          partii_client_list[cid]["webclient"].connected
      );
      if (partii_client_list[cid]["webclient"].connected == false) {
        console.log("partii_client_list[cid]" + partii_client_list[cid]);
        //     if (partii_client_list[`${client.id}`] != null) {
        if (partii_client_list[cid]["partiiclient"] != null) {
          partii_client_list[cid]["partiiclient"].end();
        }
        // }
        console.log("\tPartii client : " + cid + ", partii serevice end!!!:");
        console.log("partii_client_list[cid] : " + partii_client_list[cid]);

      //delete unconnected web client
      delete partii_client_list[cid];
      console.log("\tdelete web client : " + cid);
      }

      ////delete unconnected web client
      //delete partii_client_list[cid];
      //console.log("\tdelete web client : " + cid);
    }

    client.emit("server_setup", "true", `${client.id}`);
    if (partii_client_list[`${client.id}`] == null) {
      //first time web connect
      partii_client_list[`${client.id}`] = {
        webclient: client,
        partiiclient: null,
      };
    }

    //solve concurrent issue 25_Aug
    //Nat - Prepare metadata for partii service
    var metadata = new grpc.Metadata();
    setting["client-id"] = "partii-client-nodejs-rd-" + client.id;
    for (var key in setting) {
      metadata.add(key, setting[key]);
    }

    client.on("stream-audio", (data) => {
      if (partii_client_list[`${client.id}`]["partiiclient"] == null) {
        //if no partii connect before
        var con_status = connect_grpc(`${client.id}`, client, metadata);
        if (con_status) {
          client.emit("partii_setup", "true", `${client.id}`);
          console.log(`Partii connected [id=${client.id}] success!!!`);
        } else {
          client.emit("partii_setup", "false", `${client.id}`);
          console.log(`Partii connected [id=${client.id}] error!!!`);
        }
      } else {
        client.emit("partii_setup", "true", `${client.id}`);
      }

      console.log(
        "stream-audio " + data.clientid + ", " + data.audio_data.length
      );
      var audio16 = new Int16Array(data.audio_data);
      //console.log("stream-audio "+data.clientid+", "+audio16.length);
      var chunk = {
        ByteChunk: audio16,
        Bytelen: audio16.length,
        Datatype: 0,
      };

      processstream_live(chunk, "", data.clientid);
    });

    client.on("stop-audio", (data) => {
      console.log(
        "stop-audio " + data.clientid + ", " + data.audio_data.length
      );

      chunk = {};
      processstream_live(chunk, "EOS", data.clientid);
    });
  });
}

function processstream_live(chunk, msg_type, cid) {
  if (msg_type == "EOS") {
    console.log("EOS");

    try {
      partii_client_list[cid]["partiiclient"].end();
      //call_partii_LiveTranscribe.end();
      return true;
    } catch (err) {
      console.log("EOS error");
      return false;
    }
  } else {
    try {
      partii_client_list[cid]["partiiclient"].write(chunk);
      //call_partii_LiveTranscribe.write(chunk);
      return true;
    } catch (err) {
      console.log("EOS error");
      return false;
    }
  }
}

function connect_grpc(uuid, client, metadata) {
  try {
    if (debug == 1) {
      console.log("connect to grpc " + grpc_server + ":" + grpc_port);
    }

    var client_partii = new partii_proto.Transcription(
      grpc_server + ":" + grpc_port,
      grpc.credentials.createInsecure()
    );
    var call_partii = client_partii.LiveTranscribe(metadata);

    call_partii.on("data", function (TranscriptionResult) {
      client.emit("stream-transcript", TranscriptionResult);
      console.log(
        TranscriptionResult.sentenceType + ", " + TranscriptionResult.transcript
      );
    });

    call_partii.on("end", function () {
      if (debug == 1) {
        console.log(uuid + " end grpc");
      }
      partii_client_list[uuid]["partiiclient"] = null;
    });

    call_partii.on("error", function (e) {
      // An error has occurred and the stream has been closed.
      if (debug == 1) {
        console.log(uuid + " error grpc:" + e);
      }
      partii_client_list[uuid]["partiiclient"] = null;
      return false;
    });
  } catch (ex) {
    if (debug == 1) {
      console.log("grpc error:" + ex);
    }
    return false;
  }

  partii_client_list[uuid] = { webclient: client, partiiclient: call_partii };
  return true;
}

setupServer();

app.post("/sendFileEvent", (req, res) => {
  console.log(req.body);
  if (req.body.url) {
    io.to(req.body.user_id).emit("urlEvent", {
      url: req.body.url,
      text: req.body.text,
    });
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

io.on("connection", (socket) => {
  console.log("a user connected");
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});
