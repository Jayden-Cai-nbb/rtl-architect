`timescale 1ns/1ps
module rv_fifo #(
  parameter int DATA_W = 8,
  parameter int DEPTH = 4
) (
  input logic clk, rst_n,
  input logic [DATA_W-1:0] s_data,
  input logic s_valid,
  output logic s_ready,
  output logic [DATA_W-1:0] m_data,
  output logic m_valid,
  input logic m_ready
);
  localparam int PTR_W = $clog2(DEPTH);
  localparam int COUNT_W = $clog2(DEPTH + 1);
  logic [DATA_W-1:0] storage [0:DEPTH-1];
  logic [PTR_W-1:0] read_ptr, write_ptr;
  logic [COUNT_W-1:0] count;
  logic push, pop;
  assign s_ready = rst_n && (count < COUNT_W'(DEPTH));
  assign m_valid = rst_n && (count != 0);
  assign m_data = storage[read_ptr];
  assign push = s_valid && s_ready;
  assign pop = m_valid && m_ready;
  always_ff @(posedge clk) begin
    if (!rst_n) begin
      read_ptr <= '0;
      write_ptr <= '0;
      count <= '0;
    end else begin
      if (push) begin
        storage[write_ptr] <= s_data;
        write_ptr <= write_ptr + 1'b1;
      end
      if (pop) read_ptr <= read_ptr + 1'b1;
      case ({push, pop})
        2'b10: count <= count + 1'b1;
        2'b01: count <= count - 1'b1;
        default: count <= count;
      endcase
    end
  end
endmodule
