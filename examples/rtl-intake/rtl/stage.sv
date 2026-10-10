`timescale 1ns/1ps
module stage #(parameter BIAS = 1) (
  input wire clk, input wire rst_n,
  input wire [7:0] data_i, input wire valid_i,
  output reg [7:0] data_o, output reg valid_o
);
  always @(posedge clk) begin
    if (!rst_n) begin data_o <= 0; valid_o <= 0; end
    else begin data_o <= data_i + BIAS[7:0]; valid_o <= valid_i; end
  end
endmodule
