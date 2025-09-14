export async function openUserMedia(inputDevice, inputDevice2, audioContext, localStream, remoteStream) {
    let channels = 2; // Default to stereo
//use device 4 as the microphone input
  const stream = await navigator.mediaDevices.getUserMedia(
      {
        video: true, 
        audio: {
          deviceId: inputDevice,
          channelCount: {exact: 2},
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false, //wierdly 
          noiseSuppression: false,
          autoGainControl: false,
      }});
  const stream2 = await navigator.mediaDevices.getUserMedia(
    {
      video: false,
      audio: {
        deviceId: inputDevice2,
        channelCount: {exact: 2},
        sampleRate: 48000,
        sampleSize: 16,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }});

  // Step 2: Create Web Audio context
  audioContext = new AudioContext();
  let maxChannelCount = audioContext.destination.maxChannelCount;
  audioContext.destination.channelCount = maxChannelCount;

  // // Step 3: Use the input stream as a source node  
  const audioOnlyStream = new MediaStream(stream.getAudioTracks());
  audioOnlyStream.channelCount = channels;
  audioOnlyStream.channelCountMode = 'explicit';
  audioOnlyStream.channelInterpretation = 'discrete';
  const source = audioContext.createMediaStreamSource(audioOnlyStream);
  source.channelCount = channels; // Set to stereo
  source.channelCountMode = 'explicit';
  source.channelInterpretation = 'discrete';

  const audioOnlyStream2 = new MediaStream(stream2.getAudioTracks());
  audioOnlyStream2.channelCount = channels;
  audioOnlyStream2.channelCountMode = 'explicit';
  audioOnlyStream2.channelInterpretation = 'discrete';
  const source2 = audioContext.createMediaStreamSource(audioOnlyStream2);
  source2.channelCount = channels; // Set to stereo
  source2.channelCountMode = 'explicit';

  //uncomment below line to hear the merged audio locally
  //source.connect(audioContext.destination);
  
  //start the microphone input
  await audioContext.resume();
  
  // 🎯 Send to WebRTC
  const RTCdestination = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
  const RTCdestination2 = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
  //console.log('RTCdestination channel count:', RTCdestination.channelCount);
  //console.log('rtc track settings:', RTCdestination.stream.getAudioTracks()[0].getSettings());
  //const destination = audioContext.createMediaStreamDestination({ numberOfChannels: numInputChannels });
  //source.connect(RTCdestination);
  source.connect(RTCdestination);
  source2.connect(RTCdestination2);
  //console.log('sourcety channel count:',source.channelCount);
  // 🎥 Merge with video
  const combinedStream = new MediaStream();

  //add the video and audio tracks to the combined stream -> out
  stream.getVideoTracks().forEach(track => combinedStream.addTrack(track));
  RTCdestination.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  RTCdestination2.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  combinedStream.getTracks().forEach(track => {
    console.log(`Track ${track.kind} settings:`, track.getSettings());
    console.log(`Track ${track.kind} constraints:`, track.getConstraints());
  });

  document.querySelector('#localVideo').srcObject = stream;

  localStream = combinedStream; //might just need to be RTCdestination

  // Create a remote stream to receive the remote video and audio, ensuring it is stereo
  remoteStream = new MediaStream();

  const remoteVideoEl = document.querySelector('#remoteVideo');
  remoteVideoEl.srcObject = remoteStream;
  remoteVideoEl.muted = true;          // simplest
  remoteVideoEl.volume = 0; 

  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
}