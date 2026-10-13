`timescale 1ns/1ps
module tb;
 logic clk=0,rst_n=0; always #5 clk=~clk;
 logic [7:0] s_data=0,m_data; logic s_valid=0,s_ready,m_valid,m_ready=0;
 add_const dut(.*); rtlarch_contract_checks checks();
 initial begin
  repeat(2) @(negedge clk); rst_n=1; s_valid=1; s_data=5;
  // Fill, then keep the same unaccepted input stable during backpressure.
  @(negedge clk); s_data=9;
  repeat(3) @(negedge clk); m_ready=1;
  repeat(4) begin @(negedge clk); s_data=s_data+11; end
  @(negedge clk); s_valid=0;
  repeat(2) @(negedge clk); m_ready=0;
  @(negedge clk); rst_n=0; s_valid=1;
  repeat(2) @(negedge clk); rst_n=1; m_ready=1; s_data=255;
  repeat(4) begin @(negedge clk); s_data=s_data+37; end
  @(negedge clk); s_valid=0;
  // Finish away from both sampling edges, after the last comparison.
  repeat(2) @(negedge clk); #2; $finish;
 end
 initial begin #2000; $fatal(1,"TIMEOUT"); end
endmodule
