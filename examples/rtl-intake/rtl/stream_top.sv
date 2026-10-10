`timescale 1ns/1ps
module stream_top (
  input wire clk, input wire rst_n,
  input wire [7:0] data_i, input wire valid_i,
  output wire [7:0] data_o, output wire valid_o
);
  wire [7:0] middle; wire middle_valid;
  stage #(.BIAS(1)) first_stage (.clk(clk), .rst_n(rst_n), .data_i(data_i), .valid_i(valid_i), .data_o(middle), .valid_o(middle_valid));
  stage #(.BIAS(2)) second_stage (.clk(clk), .rst_n(rst_n), .data_i(middle), .valid_i(middle_valid), .data_o(data_o), .valid_o(valid_o));
endmodule
