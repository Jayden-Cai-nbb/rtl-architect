`timescale 1ns/1ps
module tb_stream;
  reg clk = 0, rst_n = 0, valid_i = 0;
  reg [7:0] data_i = 0;
  wire [7:0] data_o;
  wire valid_o;
  stream_top dut(.*);
  always #5 clk = ~clk;
  reg delayed_valid = 0;
  reg [7:0] delayed_data = 0;
  integer checked = 0;
  // At the sampling edge stage two consumes stage one's previous registered output.
  task automatic step(input bit reset, input bit valid, input reg [7:0] data);
    @(negedge clk); rst_n = !reset; valid_i = valid; data_i = data;
    @(posedge clk); #1;
    if (reset) begin
      if (valid_o !== 0 || data_o !== 0) $fatal(1, "reset mismatch");
      delayed_valid = 0; delayed_data = 0;
    end else begin
      if (valid_o !== delayed_valid) $fatal(1, "valid alignment mismatch");
      if (delayed_valid) begin
        if (data_o !== delayed_data) $fatal(1, "data mismatch: got %0d expected %0d",data_o,delayed_data);
        checked++;
      end
      delayed_valid = valid; delayed_data = data + 8'd3;
    end
  endtask
  initial begin
    step(1,0,0);
    for (int n=0;n<64;n++) step(n==31,n%4!=2,8'(n*17));
    step(0,0,0); step(0,0,0);
    if (checked < 40) $fatal(1, "too few checked transactions");
    $display("PASS rtl-intake: %0d transactions, bubbles, wraparound and midstream reset",checked);
    $finish;
  end
  initial begin #10000; $fatal(1,"TIMEOUT rtl-intake"); end
endmodule
