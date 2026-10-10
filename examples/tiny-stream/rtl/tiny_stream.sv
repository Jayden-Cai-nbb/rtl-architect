`timescale 1ns/1ps
// Hand-written fixture implementation. The editor never rewrites this RTL.
module tiny_stream #(
  parameter int DATA_W = 8
) (
  input logic clk, rst_n,
  input logic [DATA_W-1:0] s_data,
  input logic s_valid,
  output logic s_ready,
  output logic [DATA_W-1:0] m_data,
  output logic m_valid,
  input logic m_ready
);
  stream_path #(.DATA_W(DATA_W), .DEPTH(4), .CONST(DATA_W'(3))) path (
    .clk, .rst_n, .s_data, .s_valid, .s_ready, .m_data, .m_valid, .m_ready
  );
endmodule
