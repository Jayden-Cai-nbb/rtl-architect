`timescale 1ns/1ps
module tb;
  logic clk=0, rst_n=0; always #5 clk=~clk;
  logic [7:0] s_data=0, m_data;
  logic s_valid=0, s_ready, m_valid, m_ready=0;
  rv_fifo dut(.*);
  rtlarch_contract_checks checks();
  initial begin
    repeat(2) @(negedge clk); rst_n=1;
    @(negedge clk); s_valid=1; s_data=8'h11;
    @(negedge clk); s_data=8'h22;
    @(negedge clk); s_valid=0;
    repeat(3) @(negedge clk); m_ready=1;
    repeat(5) @(negedge clk); $finish;
  end
endmodule
