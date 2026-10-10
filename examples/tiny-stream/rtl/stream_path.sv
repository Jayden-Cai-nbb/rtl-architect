`timescale 1ns/1ps
module stream_path #(
  parameter int DATA_W = 8,
  parameter int DEPTH = 4,
  parameter logic [DATA_W-1:0] CONST = DATA_W'(3)
) (
  input logic clk, rst_n,
  input logic [DATA_W-1:0] s_data,
  input logic s_valid,
  output logic s_ready,
  output logic [DATA_W-1:0] m_data,
  output logic m_valid,
  input logic m_ready
);
  logic [DATA_W-1:0] mid_data;
  logic mid_valid, mid_ready;
  rv_fifo #(.DATA_W(DATA_W), .DEPTH(DEPTH)) fifo (
    .clk, .rst_n, .s_data, .s_valid, .s_ready,
    .m_data(mid_data), .m_valid(mid_valid), .m_ready(mid_ready)
  );
  add_const #(.DATA_W(DATA_W), .CONST(CONST)) add (
    .clk, .rst_n, .s_data(mid_data), .s_valid(mid_valid), .s_ready(mid_ready),
    .m_data, .m_valid, .m_ready
  );
endmodule
