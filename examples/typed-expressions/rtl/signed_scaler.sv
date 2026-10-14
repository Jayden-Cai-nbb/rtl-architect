module signed_scaler (
  input logic clk, rst_n, enable,
  input logic signed [7:0] sample,
  input logic [3:0] shift,
  output logic signed [11:0] scaled,
  output logic [7:0] packed_value, logical_value,
  output logic negative, parity
);
  wire signed [11:0] extended_sample = {{4{sample[7]}}, sample};
  always_ff @(posedge clk) begin
    if (!rst_n) begin
      scaled <= '0;
      packed_value <= '0;
      logical_value <= '0;
      negative <= 1'b0;
      parity <= 1'b0;
    end else if (enable) begin
      scaled <= extended_sample >>> shift;
      packed_value <= 8'(extended_sample >>> shift);
      logical_value <= $unsigned(sample) >> shift;
      negative <= sample < 8'sd0;
      parity <= ^sample;
    end
  end
endmodule
