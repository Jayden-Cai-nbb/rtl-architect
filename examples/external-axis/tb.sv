// Independent transaction scoreboard, without generated register-update expectations.
module tb;
logic clk=0,rst=1; logic [7:0] s_axis_tdata=0; logic s_axis_tvalid=0,m_axis_tready=0;
wire s_axis_tready,m_axis_tvalid; wire [7:0] m_axis_tdata;
axis_pair dut(.*);
byte unsigned queue[$]; int accepted=0,delivered=0,stalls=0,flushed=0; bit was_stalled=0; byte unsigned held;
always #5 clk=~clk;
always @(posedge clk) begin
 if(rst) begin flushed+=queue.size();queue.delete();was_stalled=0;end
 else begin
  if(was_stalled && (!m_axis_tvalid || m_axis_tdata !== held)) $fatal(1,"STALL_CHANGED");
  if(m_axis_tvalid && m_axis_tready) begin
   if(queue.size()==0) $fatal(1,"UNEXPECTED_OUTPUT");
   if(m_axis_tdata !== queue.pop_front()) $fatal(1,"DATA_OR_ORDER_MISMATCH");
   delivered++;
  end
  if(s_axis_tvalid && s_axis_tready) begin queue.push_back(s_axis_tdata);accepted++;end
  was_stalled=m_axis_tvalid && !m_axis_tready;held=m_axis_tdata;if(was_stalled)stalls++;
 end
end
initial begin
 bit pending; byte unsigned next_data; bit take_input;
 repeat(3) @(negedge clk); rst=0;
 for(int cycle=0;cycle<700;cycle++) begin
  // A sender changes its transaction only after the previous sampling-edge handshake.
  s_axis_tvalid=pending || cycle%5!=0; if(!pending) s_axis_tdata=next_data;
  m_axis_tready=(cycle%11>=4);
  rst=(cycle==243 || cycle==244);
  @(posedge clk);take_input=s_axis_tvalid && s_axis_tready && !rst;
  @(negedge clk);
  pending=!rst && s_axis_tvalid && !take_input;
  if(take_input)next_data++;
 end
 // Finish any offered transaction, then drain with a bounded timeout.
 rst=0;m_axis_tready=1;
 while(pending) begin @(posedge clk);take_input=s_axis_tready;@(negedge clk);if(take_input)pending=0;end
 s_axis_tvalid=0;
 repeat(12) @(negedge clk);
 if(queue.size()!=0 || accepted!=delivered+flushed || delivered<100 || stalls<20 || flushed==0) $fatal(1,"COVERAGE_OR_DRAIN");
 $display("EXTERNAL_AXIS_PASS accepted=%0d delivered=%0d flushed=%0d stalls=%0d",accepted,delivered,flushed,stalls);$finish;
end
initial begin #20000;$fatal(1,"TIMEOUT");end
endmodule
