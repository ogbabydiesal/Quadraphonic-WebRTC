function setup() {
//creates a canvas 600 pixels wide
//and 400 pixels high
  createCanvas(200, 200);
}
function draw() {
    console.log('hello')
//sky blue background
  background(220);
  fill('red');
  rect(0, 0, 10, 10)
  rect(width -10, 0, 10, 10)
  rect(0, height - 10, 10, 10)
  rect(width -10, height - 10, 10, 10)
  noFill()
  circle(width/2, height/2, 195)
}