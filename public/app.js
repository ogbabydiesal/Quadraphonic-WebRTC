
import { handleTrackEvent } from './trackHandler.js';
let audioContext = null;
let channels = 2; // Default to stereo
let audioTracks = [];
let gains = [];
mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

const configuration = {
  //  iceServers: [
  //   {
  //     urls: [
  //       'stun:stun1.l.google.com:19302',
  //       'stun:stun2.l.google.com:19302',
  //     ],
  //   },
  // ],
  iceServers: [{   urls: [ "stun:us-turn1.xirsys.com" ]}, {   username: "7H2qmpDLA7VVsPxy8WgM8EVdh5qLSdqsIeqISxYj2Ge8YtOorR0iMxSeJDtFYa9BAAAAAGjUsoVvZ2JhYnlkaWVzYWw=",   credential: "1dbc5ed8-99bd-11f0-9ed2-0242ac140004",   urls: [       "turn:us-turn1.xirsys.com:80?transport=udp",       "turn:us-turn1.xirsys.com:3478?transport=udp",       "turn:us-turn1.xirsys.com:80?transport=tcp",       "turn:us-turn1.xirsys.com:3478?transport=tcp",       "turns:us-turn1.xirsys.com:443?transport=tcp",       "turns:us-turn1.xirsys.com:5349?transport=tcp"   ]}],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let roomDialog = null;
let roomId = null;

let inputDevice = null;
let inputDevice_Video = null;
let outputDevice = ''; // '' = system default output

// local monitor and peer playback each get their own gain before the output
let localGainNode = null;
let peerGainNode = null;
let peerAudioConnected = false;

let infoPanel = true;
//mouse click
document.querySelector('#info').addEventListener('click', () => {
  infoPanel = !infoPanel;
  document.querySelector('#infoContainer').style.display = infoPanel ? 'flex' : 'none';
});

async function getAudioVideoInputDevices() {
  // input permission must be granted first so output labels are populated too
  await getAudioInputDevices();
  await getVideoInputDevices();
  await getAudioOutputDevices();
}

function init() {
  document.querySelector('#inDeviceBtn').addEventListener('click', getAudioVideoInputDevices);
  document.getElementById('audioInputSelect').addEventListener('change', async (e) => {
    inputDevice = e.target.value;
    console.log('Selected input device:', inputDevice);

  });
  document.getElementById('videoInputSelect').addEventListener('change', async (e) => {
    inputDevice_Video = e.target.value;
    console.log('Selected video device:', inputDevice_Video);
  });
  document.getElementById('audioOutputSelect').addEventListener('change', async (e) => {
    outputDevice = e.target.value;
    console.log('Selected output device:', outputDevice || 'system default');
    await applyOutputDevice();
  });
  document.getElementById('localGainSlider').addEventListener('input', (e) => {
    setGain(localGainNode, parseFloat(e.target.value));
  });
  document.getElementById('peerGainSlider').addEventListener('input', (e) => {
    setGain(peerGainNode, parseFloat(e.target.value));
  });

  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));
}

function setGain(gainNode, value) {
  if (!gainNode) return; // sliders can move before the audio context exists
  gainNode.gain.setTargetAtTime(value, audioContext.currentTime, 0.02);
}

async function applyOutputDevice() {
  if (!audioContext) return; // picked up by the AudioContext constructor in openUserMedia
  if (typeof audioContext.setSinkId !== 'function') {
    console.warn('AudioContext.setSinkId is not supported in this browser');
    return;
  }
  try {
    await audioContext.setSinkId(outputDevice);
    // the new device may have a different channel count (e.g. a quad interface)
    audioContext.destination.channelCount = audioContext.destination.maxChannelCount;
    console.log('Output channel count:', audioContext.destination.channelCount);
  } catch (error) {
    console.error('Error setting output device:', error);
  }
}

// 'track' fires once per remote track (1 video + 4 audio), so only add that
// event's track, and build the quad graph a single time once all 4 audio
// tracks are in the stream. Building it per event played the peer ~5x over.
function handleRemoteTrack(event) {
  remoteStream.addTrack(event.track);
  if (peerAudioConnected) return;

  const remoteAudioTracks = event.streams[0] ? event.streams[0].getAudioTracks() : [];
  if (remoteAudioTracks.length < 4) return; // wait for the rest of the channels
  peerAudioConnected = true;

  let merger = audioContext.createChannelMerger(4);
  merger.channelCountMode = 'explicit';
  merger.channelInterpretation = 'speakers';
  audioTracks = [];

  remoteAudioTracks.forEach(track => {
    //map the audio track to web audio api
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    audioTracks.push(source);
  });
  for (let i = 0; i < 4; i++) {
    const gainNode = audioContext.createGain();
    gains.push(gainNode.gain);
    audioTracks[i].connect(gainNode);
    gainNode.connect(merger, 0, i);
  }
  merger.connect(peerGainNode);
  audioContext.resume();
}

function mungeSDP(sdp) {
  // Force stereo in Opus (common for multichannel needs)
   sdp = sdp.replace(/a=fmtp:111 minptime=10;useinbandfec=1/g,
                      'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1');

  //sdp = sdp.replace("opus/48000/2","multiopus/48000/4").replace("useinbandfec=1", "channel_mapping=0,1,2,3; num_streams=4; coupled_streams=0;maxaveragebitrate=510000;minptime=10;useinbandfec=1");


  // You could also try forcing the number of channels (not always honored)
   //sdp = sdp.replace(/a=rtpmap:111 opus\/48000\/2/g, 'a=rtpmap:111 multiopus/48000/4');

  // If you want to inspect what codecs are negotiated:
  // console.log(sdp);

  return sdp;
}


async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();
  const roomRef = await db.collection('rooms').doc();
  
  //comment this line out and remove fixedRoomId above when you want to use a secret pass
  //roomId = fixedRoomId;
  
  //console.log('Create PeerConnection with configuration: ', configuration);
  peerConnection = new RTCPeerConnection(configuration);

  registerPeerConnectionListeners();

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Code for collecting ICE candidates below
  const callerCandidatesCollection = roomRef.collection('callerCandidates');

  peerConnection.addEventListener('icecandidate', event => {
    if (!event.candidate) {
      //console.log('Got final candidate!');
      return;
    }
    //console.log('Got candidate: ', event.candidate);
    callerCandidatesCollection.add(event.candidate.toJSON());
  });
  // Code for collecting ICE candidates above

  // Code for creating a room below
  const offer = await peerConnection.createOffer();
  
  //MUNGE THE SDP
  offer.sdp = mungeSDP(offer.sdp);
  
  await peerConnection.setLocalDescription(offer);
  //console.log("SDP Offer:\n", peerConnection.localDescription.sdp);
  //console.log('Created offer:', offer);

  const roomWithOffer = { 
    'offer': {
      type: offer.type,
      sdp: offer.sdp,
    },
  };
  await roomRef.set(roomWithOffer);
  //console.log('roomWithOffer:' + roomWithOffer)
  roomId = roomRef.id;
  //console.log(`New room created with SDP offer. Room ID: ${roomRef.id}`);
  //write the roomRef to the UI
  
  document.querySelector(
      '#currentRoom').innerText = `Room ID: ${roomRef.id} - You are the caller!`;
  // Code for creating a room above

  peerConnection.addEventListener('track', handleRemoteTrack);

  // Listening for remote session description below
  roomRef.onSnapshot(async snapshot => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data && data.answer) {
      //console.log('Got remote description: ', data.answer);
      const rtcSessionDescription = new RTCSessionDescription(data.answer);
      await peerConnection.setRemoteDescription(rtcSessionDescription);
    }
  });
  // Listening for remote session description above

  // Listen for remote ICE candidates below
  roomRef.collection('calleeCandidates').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        let data = change.doc.data();
        //console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
        await peerConnection.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });
  // Listen for remote ICE candidates above
}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  document.querySelector('#confirmJoinBtn').
      addEventListener('click', async () => {
        //console.log('Join room button clicked');
        roomId = document.querySelector('#room-id').value;
        //console.log('Join room: ', roomId);
        document.querySelector(
            '#currentRoom').innerText = `Room ID: ${roomId} - You are the callee!`;
        await joinRoomById(roomId);
      }, {once: true});
  roomDialog.open();
}

async function joinRoomById(roomId) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  //console.log('Got room:', roomSnapshot.exists);

  if (roomSnapshot.exists) {
    //console.log('Create PeerConnection with configuration: ', configuration);
    peerConnection = new RTCPeerConnection(configuration);
    registerPeerConnectionListeners();
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Code for collecting ICE candidates below
    const calleeCandidatesCollection = roomRef.collection('calleeCandidates');
    peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        //console.log('Got final candidate!');
        return;
      }
      //console.log('Got candidate: ', event.candidate);
      calleeCandidatesCollection.add(event.candidate.toJSON());
    });
    // Code for collecting ICE candidates above

    peerConnection.addEventListener('track', handleRemoteTrack);

    // Code for creating SDP answer below
    const offer = roomSnapshot.data().offer;
    //console.log('Got offer:', offer);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    //console.log("📥 Received offer SDP:\n", offer.sdp);
    const answer = await peerConnection.createAnswer();
    //console.log('Created answer:', answer);
    await peerConnection.setLocalDescription(answer);

    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
    };

    await roomRef.update(roomWithAnswer);
    // Code for creating SDP answer above

    // Listening for remote ICE candidates below
    roomRef.collection('callerCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          let data = change.doc.data();
          //console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
          
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
          //console.log("channel info here: " + peerConnection.localDescription.sdp);
        }
      });
    });
    // Listening for remote ICE candidates above
  }
}

async function openUserMedia() {
  //debug the input device name
  if (inputDevice) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selectedDevice = devices.find(device => device.deviceId === inputDevice);
    console.log('Selected input device name:', selectedDevice ? selectedDevice.label : 'Unknown device');
  }
  //use device 4 as the microphone input
  const stream = await navigator.mediaDevices.getUserMedia(
      {
        video: {
          deviceId: inputDevice_Video ? { exact: inputDevice_Video } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          deviceId: inputDevice ? { exact: inputDevice } : undefined,
          // 4 discrete channels where the device has them (Firefox), else falls back to stereo
          channelCount: { ideal: 4 },
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false, //wierdly 
          noiseSuppression: false,
          autoGainControl: false,
      }});
  const inputChannels = stream.getAudioTracks()[0].getSettings().channelCount || 2;
  console.log('Input channel count:', inputChannels);

  // Step 2: Create Web Audio context
  audioContext = new AudioContext(outputDevice ? { sinkId: outputDevice } : {});
  let maxChannelCount = audioContext.destination.maxChannelCount;
  audioContext.destination.channelCount = maxChannelCount;

  // 🔊 Local playback: monitor of our inputs, and the peer's audio (connected on 'track')
  localGainNode = audioContext.createGain();
  localGainNode.gain.value = parseFloat(document.getElementById('localGainSlider').value);
  localGainNode.connect(audioContext.destination);
  peerGainNode = audioContext.createGain();
  peerGainNode.gain.value = parseFloat(document.getElementById('peerGainSlider').value);
  peerGainNode.connect(audioContext.destination);

  // // Step 3: Use the input stream as a source node
  const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));

  // one mono WebRTC track per input channel; with a stereo device the
  // splitter outputs silence on 3 and 4, so the peer always gets 4 tracks
  const micSplitter = audioContext.createChannelSplitter(4);
  source.connect(micSplitter);

  // hear the inputs locally, level set by the Local Gain slider
  source.connect(localGainNode);

  //start the microphone input
  await audioContext.resume();
  
  // 🎥 Merge with video
  const combinedStream = new MediaStream();

  //add the video and audio tracks to the combined stream -> out
  stream.getVideoTracks().forEach(track => combinedStream.addTrack(track));
  for (let i = 0; i < 4; i++) {
    // 🎯 Send to WebRTC
    const channelNode = audioContext.createGain({channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'});
    const RTCdestination = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
    micSplitter.connect(channelNode, i);
    channelNode.connect(RTCdestination);
    RTCdestination.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  }
  combinedStream.getTracks().forEach(track => {
    //.log(`Track ${track.kind} settings:`, track.getSettings());
    //console.log(`Track ${track.kind} constraints:`, track.getConstraints());
  });

  document.querySelector('#localVideo').srcObject = stream;
  document.querySelector('#localVideo').style.display = 'block';
  localStream = combinedStream; //might just need to be RTCdestination

  // Create a remote stream to receive the remote video and audio, ensuring it is stereo
  remoteStream = new MediaStream();

  const remoteVideoEl = document.querySelector('#remoteVideo');
  remoteVideoEl.srcObject = remoteStream;
  remoteVideoEl.style.display = 'block';
  remoteVideoEl.muted = true; // simplest
  remoteVideoEl.volume = 0; 

  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
}

async function getAudioInputDevices() {
  await  navigator.mediaDevices.getUserMedia({ audio: true });
  navigator.mediaDevices.enumerateDevices()
    .then(devices => {
      const audioInputDevices = devices.filter(device => device.kind === 'audioinput');
      const audioInputSelect = document.getElementById('audioInputSelect');
      audioInputSelect.innerHTML = '';
      audioInputDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${audioInputDevices.indexOf(device) + 1}`;
        audioInputSelect.appendChild(option);
      });
    })
    .catch(error => {
      console.error('Error getting audio input devices:', error);
    });
}

async function getAudioOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
    const audioOutputSelect = document.getElementById('audioOutputSelect');
    audioOutputSelect.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'system default';
    audioOutputSelect.appendChild(defaultOption);
    audioOutputDevices.forEach(device => {
      // 'default' duplicates the system default entry above
      if (device.deviceId === 'default') return;
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Speaker ${audioOutputDevices.indexOf(device) + 1}`;
      audioOutputSelect.appendChild(option);
    });
    audioOutputSelect.value = outputDevice;
  } catch (error) {
    console.error('Error getting audio output devices:', error);
  }
}

async function getVideoInputDevices() {
  await  navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  navigator.mediaDevices.enumerateDevices()
    .then(devices => {
      const videoInputDevices = devices.filter(device => device.kind === 'videoinput');
      const videoInputSelect = document.getElementById('videoInputSelect');
      videoInputSelect.innerHTML = '';
      videoInputDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${videoInputDevices.indexOf(device) + 1}`;
        videoInputSelect.appendChild(option);
      });
    })
    .catch(error => {
      console.error('Error getting video input devices:', error);
    });
}

// function toggleAudioChannel(channelIndex) {
//   return function() {
//     const checkbox = document.querySelector(`#audioCheckboxCh_${channelIndex + 1}`);
//     if (checkbox.checked) {
//       audioTracks[channelIndex].gain.value = 1; // Enable channel
//       console.log(`Channel ${channelIndex + 1} enabled`);
//     } else {
//       audioTracks[channelIndex].gain.value = 0; // Disable channel
//       console.log(`Channel ${channelIndex + 1} disabled`);
//     }
//   };
// }

async function hangUp(e) {
  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }

  if (peerConnection) {
    peerConnection.close();
  }

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup
  if (roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection('rooms').doc(roomId);
    const calleeCandidates = await roomRef.collection('calleeCandidates').get();
    calleeCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
    const callerCandidates = await roomRef.collection('callerCandidates').get();
    callerCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
    await roomRef.delete();
  }

  document.location.reload(true);
}

function registerPeerConnectionListeners() {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    //console.log(`ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    //console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    //console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    //console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

init();
