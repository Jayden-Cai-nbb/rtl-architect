`timescale 1ns/1ps
module add_const #(
  parameter int DATA_W = 8,
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
  logic out_valid;
  logic [DATA_W-1:0] out_data;
  assign s_ready = rst_n && (!out_valid || m_ready);
  assign m_valid = rst_n && out_valid;
  assign m_data = out_data;
  always_ff @(posedge clk) begin
    if (!rst_n) begin
      out_valid <= 1'b0;
      out_data <= '0;
    end else if (s_ready) begin
      out_valid <= s_valid;
      if (s_valid) out_data <= s_data + CONST;
    end
  end
endmodule
